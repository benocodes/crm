import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// OPS670: the command line's --out, relative to the repo root or absolute. The command runs as a child process.
const CLI = new URL('./cli.ts', import.meta.url).pathname
const ROOT = join(import.meta.dirname, '..', '..')
let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('--out', () => {
  it('an absolute --out is used as given: both files land there and nothing appears under the repo root', () => {
    dir = mkdtempSync(join(tmpdir(), 'scan-cli-'))
    const r = spawnSync(process.execPath, [CLI, 'extract', '--out', dir], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(existsSync(join(dir, 'candidates.json'))).toBe(true)
    expect(existsSync(join(dir, 'candidates.md'))).toBe(true)
    expect(existsSync(join(ROOT, dir))).toBe(false)
  })
})
