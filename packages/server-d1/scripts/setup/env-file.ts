// The Clerk env file's probe ([[OPS65]] D34): where the path goes, whether it is the root `.env`, whether git ignores it, its text. It reads
// nothing from `process.env` and never prints a value.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
