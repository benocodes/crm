import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { run } from './cli.js'
import type { InstanceMain } from './types.js'
// Injected by `scripts/build.ts` from `@vault/release`'s package.json ([[OPS210]] D1); an unbuilt run (tsx) is `dev`.
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
// [[OPS231]] D12: `cli/instance.js` beside this file in a release package. Loaded by a computed URL, so the bundler never inlines it into the client.
const loadInstance = async () => {
  const url = new URL('./instance.js', import.meta.url)
  return existsSync(fileURLToPath(url)) ? ((await import(url.href)).default as InstanceMain) : undefined
}
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
  loadInstance,
  version: typeof __VIBASE_VERSION__ === 'string' ? __VIBASE_VERSION__ : 'dev',
})
process.exitCode = code
