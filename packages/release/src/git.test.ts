import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseCommit } from './git.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'ops210-git-'))
  dirs.push(d)
  git(d, 'init', '-q')
  writeFileSync(join(d, 'a.txt'), '1')
  git(d, 'add', 'a.txt')
  git(d, 'commit', '-qm', 'one')
  return d
}

describe('D4 commit', () => {
  it('a clean tree names HEAD', () => {
    const d = repo()
    expect(releaseCommit({ cwd: d })).toBe(git(d, 'rev-parse', 'HEAD'))
  })
  it('untracked files do not make the tree dirty', () => {
    const d = repo()
    writeFileSync(join(d, 'new.txt'), 'x')
    expect(releaseCommit({ cwd: d })).toBe(git(d, 'rev-parse', 'HEAD'))
  })
  it('a modified tracked file refuses without --allow-dirty', () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), '2')
    expect(() => releaseCommit({ cwd: d })).toThrow(/uncommitted/)
  })
  it('--allow-dirty records <sha>-dirty, only when dirty', () => {
    const d = repo()
    const head = git(d, 'rev-parse', 'HEAD')
    expect(releaseCommit({ cwd: d, allowDirty: true })).toBe(head)
    writeFileSync(join(d, 'a.txt'), '2')
    expect(releaseCommit({ cwd: d, allowDirty: true })).toBe(`${head}-dirty`)
  })
})
