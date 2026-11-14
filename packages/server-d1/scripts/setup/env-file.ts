// The Clerk env file's probe ([[OPS65]] D34): where the path goes, whether it is the root `.env`, whether git ignores it, its text. It reads
// nothing from `process.env` and never prints a value.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { EnvFileProbe } from './types.js'

/** `arg` is resolved against the repo root (pnpm `-C` moves the working directory); the default is `.env.<env>` there. */
export function probeEnvFile(arg: string | undefined, envName: string, repoRoot: string, rootEnvPath: string): EnvFileProbe {
  const given = arg ?? `.env.${envName}`
  const path = isAbsolute(given) ? given : resolve(repoRoot, given)
  const display = arg ?? `.env.${envName}`
  // Real paths on both sides: in a worktree the root `.env` is a symlink, and a symlink to it is still it.
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const target = real(path)
  const root = real(rootEnvPath) ?? resolve(rootEnvPath)
  if (resolve(path) === resolve(rootEnvPath) || (target !== null && target === root)) return { display, status: 'root-env' }
  if (target === null || !existsSync(target)) return { display, status: 'missing' }
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: repoRoot })
  if (ignored.status !== 0) return { display, status: 'not-ignored' }
  return { display, status: 'ok', text: readFileSync(target, 'utf8') }
}

/**
 * Appends `NAME=value` to the instance's own env file ([[OPS249]] D3: `AUTH_SECRET`), creating it with mode 600 when it is missing. The same path rule as the probe; the root `.env` is
 * refused (it holds another instance's values) and a name already assigned is never overwritten. The value is written to the file only.
 */
export function appendEnvFileVar(arg: string | undefined, envName: string, name: string, value: string, repoRoot: string, rootEnvPath: string): void {
  const given = arg ?? `.env.${envName}`
  const path = isAbsolute(given) ? given : resolve(repoRoot, given)
  if (resolve(path) === resolve(rootEnvPath)) throw new Error(`${given} is the root .env, which holds another instance's values`)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (text !== null && new RegExp(`^\\s*(export\\s+)?${name}=`, 'm').test(text)) throw new Error(`${name} is already set in ${given}: refusing to overwrite a key`)
  const line = `${text === null || text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${value}\n`
  if (text === null) writeFileSync(path, line, { mode: 0o600 })
  else appendFileSync(path, line)
}
