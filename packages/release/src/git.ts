// The commit a build names ([[OPS210]] D4): HEAD, with `-dirty` only when the caller allowed uncommitted changes to tracked files.
import { execFileSync } from 'node:child_process'
import { ReleaseRefusal } from './errors.js'

export function releaseCommit(opts: { cwd: string; allowDirty?: boolean }): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' }).trim()
  const sha = git('rev-parse', 'HEAD')
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== ''
  if (!dirty) return sha
  if (!opts.allowDirty) throw new ReleaseRefusal('uncommitted changes to tracked files: commit them, or pass --allow-dirty (the build is then recorded as <sha>-dirty)')
  return `${sha}-dirty`
}
