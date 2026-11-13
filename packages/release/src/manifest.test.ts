import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '@vault/storage-d1'
import { sources } from './fixtures.js'
import { assertRelease, listFiles, sha256, verifyRelease } from './manifest.js'
import { stageRelease } from './stage.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function stage() {
  const s = sources()
  const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
  dirs.push(s.root, outDir)
  const manifest = stageRelease({ ...s, outDir })
  return { outDir, manifest, s }
}

describe('D4 release.json', () => {
  it('has every field, and files covers every file but release.json and package.json', () => {
    const { outDir, manifest, s } = stage()
    expect(Object.keys(manifest).sort()).toEqual(['built_at', 'commit', 'compatibility_date', 'files', 'migrations', 'name', 'node', 'version', 'wrangler'])
    expect(manifest).toMatchObject({ name: 'vibase', version: '0.1.0', commit: 'abc1234', wrangler: '4.149.0', compatibility_date: '2026-07-30', node: '>=22' })
    expect(JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8'))).toEqual(manifest)
    expect(Object.keys(manifest.files).sort()).toEqual(listFiles(outDir).filter((f) => f !== 'release.json' && f !== 'package.json'))
    expect(manifest.files['worker/worker.js']).toBe(sha256(readFileSync(s.workerEntry)))
    expect(manifest.migrations).toEqual(s.migrations)
  })
  it('migrations equal the CORE61 manifest with correct hashes (the real files)', () => {
    const dir = new URL('../../storage-d1/migrations/', import.meta.url).pathname
    const s = sources()
    dirs.push(s.root)
    const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
    dirs.push(outDir)
    const m = stageRelease({ ...s, outDir, migrationsDir: dir, migrations: MIGRATIONS })
    expect(m.migrations).toEqual(MIGRATIONS)
    expect(verifyRelease(outDir)).toEqual([])
  })
  it('absence: a manifest that drops one file entry is refused as extra', () => {
    const { outDir } = stage()
    const p = join(outDir, 'release.json')
    const m = JSON.parse(readFileSync(p, 'utf8'))
    delete m.files['cli/vibase.js']
    writeFileSync(p, JSON.stringify(m))
    expect(verifyRelease(outDir)).toContainEqual({ path: 'cli/vibase.js', kind: 'extra' })
  })
})

describe('D4 verify refusals', () => {
  it('a clean stage verifies', () => {
    expect(verifyRelease(stage().outDir)).toEqual([])
  })
  it.each(['worker/worker.js', 'assets/connect/index.html', 'migrations/0001_a.sql', 'cli/vibase.js'])('a changed byte in %s names the path', (f) => {
    const { outDir } = stage()
    writeFileSync(join(outDir, f), readFileSync(join(outDir, f), 'utf8') + ' ')
    expect(verifyRelease(outDir)).toEqual([{ path: f, kind: 'mismatch' }])
    expect(() => assertRelease(outDir)).toThrow(f)
  })
  it.each(['worker/worker.js', 'assets/connect/connect.js', 'migrations/0002_b.sql'])('a missing %s names the path', (f) => {
    const { outDir } = stage()
    unlinkSync(join(outDir, f))
    expect(verifyRelease(outDir)).toContainEqual({ path: f, kind: 'missing' })
    expect(() => assertRelease(outDir)).toThrow(f)
  })
  it.each(['worker/extra.js', 'assets/connect/extra.js', 'migrations/0003_c.sql'])('an extra %s names the path', (f) => {
    const { outDir } = stage()
    mkdirSync(join(outDir, f, '..'), { recursive: true })
    writeFileSync(join(outDir, f), 'x')
    expect(verifyRelease(outDir)).toEqual([{ path: f, kind: 'extra' }])
    expect(() => assertRelease(outDir)).toThrow(f)
  })
  it('a migrations entry whose hash differs from the file is refused', () => {
    const { outDir } = stage()
    const p = join(outDir, 'release.json')
    const m = JSON.parse(readFileSync(p, 'utf8'))
    m.migrations[0].sha256 = '0'.repeat(64)
    writeFileSync(p, JSON.stringify(m))
    expect(verifyRelease(outDir)).toContainEqual({ path: 'migrations/0001_a.sql', kind: 'mismatch' })
  })
})
