// The password-hasher measurement ([[CORE243]] D13, P3): scrypt (Better Auth's default) and Web Crypto PBKDF2-SHA256 timed in workerd (Miniflare), N whole requests each.
//
//   pnpm -C packages/auth hasher:measure [--n 20] [--iterations 100000]
//
// workerd's clock (`Date.now()`, `performance.now()`) does not advance during CPU work, so a Worker cannot time itself: each request does ONE hash and the caller times the request
// (the dispatch round trip is measured the same way with a no-op request and reported separately). A local wall-clock time is a PROXY for Cloudflare CPU time, never the number
// Cloudflare bills against the 10 ms Free-plan budget. It also probes the PBKDF2 iteration cap by asking workerd for counts above 100,000.
import { fileURLToPath } from 'node:url'
import { bundleWorker, startWorkerd } from '../src/test/index.js'

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const N = arg('n', 20)
const ITERATIONS = arg('iterations', 100_000)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const ms = (x: number) => x.toFixed(2)

const bundle = await bundleWorker(fileURLToPath(new URL('../src/test/entry.ts', import.meta.url)))
const w = await startWorkerd({ bundle, migrate: false })
try {
  const time = async (path: string) => {
    const t0 = performance.now()
    const res = await w.call(path)
    const t = performance.now() - t0
    return { t, status: res.status, body: await res.text() }
  }
  const series = async (label: string, path: string) => {
    await time(path) // warm-up: isolate start, JIT
    const ts: number[] = []
    for (let i = 0; i < N; i++) {
      const r = await time(path)
      if (r.status !== 200) throw new Error(`${label}: ${r.status} ${r.body}`)
      ts.push(r.t)
    }
    return { label, n: ts.length, median: median(ts), max: Math.max(...ts), min: Math.min(...ts) }
  }
  const baseline = await series('no-op request (dispatch round trip)', '/__noop')
  const rows = [baseline, await series('scrypt (Better Auth default, one hash)', '/__hash?kdf=scrypt'), await series(`PBKDF2-SHA256, ${ITERATIONS} iterations (one hash)`, `/__hash?kdf=pbkdf2&iterations=${ITERATIONS}`)]
  console.log(`N = ${N} requests per series after one warm-up; times are wall-clock milliseconds as seen by the caller (a proxy for Workers CPU time)`)
  console.log(`${'series'.padEnd(52)} ${'median'.padStart(8)} ${'max'.padStart(8)} ${'min'.padStart(8)}   median minus no-op`)
  for (const r of rows) console.log(`${r.label.padEnd(52)} ${ms(r.median).padStart(8)} ${ms(r.max).padStart(8)} ${ms(r.min).padStart(8)}   ${r === baseline ? '-' : ms(r.median - baseline.median)}`)
  console.log('\nPBKDF2 iteration cap in workerd (one hash each; 200 = accepted):')
  for (const n of [100_000, 100_001, 200_000, 600_000, 1_000_000]) {
    const r = await time(`/__hash?kdf=pbkdf2&iterations=${n}`)
    console.log(`  ${String(n).padStart(9)} iterations -> ${r.status}${r.status === 200 ? ` (${ms(r.t)} ms)` : ` ${r.body}`}`)
  }
} finally {
  await w.dispose()
  bundle.dispose()
}
