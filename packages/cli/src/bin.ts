import { homedir } from 'node:os'
import { run } from './cli.js'
// Injected by `scripts/build.ts` from `@vibase/release`'s package.json ([[OPS210]] D1); an unbuilt run (tsx) is `dev`.
declare const __VIBASE_VERSION__: string | undefined

const readStdin = async () => {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
const sink = (s: NodeJS.WriteStream) => ({
  isTTY: Boolean(s.isTTY),
  write: (chunk: string | Uint8Array) => new Promise<void>((resolve, reject) => s.write(chunk, (e) => (e ? reject(e) : resolve()))),
})
const code = await run(process.argv.slice(2), {
  fetch,
  env: process.env,
  stdout: sink(process.stdout),
  stderr: sink(process.stderr),
  readStdin,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  homedir: homedir(),
  version: typeof __VIBASE_VERSION__ === 'string' ? __VIBASE_VERSION__ : 'dev',
})
process.exitCode = code
