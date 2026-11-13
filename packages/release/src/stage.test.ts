import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { sources } from './fixtures.js'
import { listFiles, verifyRelease } from './manifest.js'
import { deriveBaseConfig, publishedPackageJson, readWranglerVersion, stageRelease } from './stage.js'

const SERVER_D1_PKG = new URL('../../server-d1/package.json', import.meta.url).pathname
const WRANGLER_JSONC = new URL('../../server-d1/wrangler.jsonc', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('D3 layout (cycle-1 subset)', () => {
  it('the staged package holds exactly the cycle-1 files', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
    dirs.push(s.root, outDir)
    stageRelease({ ...s, outDir })
    expect(listFiles(outDir)).toEqual([
      'LICENSE', 'README.md', 'assets/connect/connect.js', 'assets/connect/index.html', 'cli/instance.js', 'cli/vibase.js',
      'migrations/0001_a.sql', 'migrations/0002_b.sql', 'package.json', 'release.json', 'worker/worker.js', 'wrangler.base.jsonc',
    ])
  })
})

describe('D12 cli/instance.js', () => {
  it('is staged and covered by release.json files (so verify refuses a tampered or removed one)', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops231-out-'))
    dirs.push(s.root, outDir)
    const manifest = stageRelease({ ...s, outDir })
    expect(Object.keys(manifest.files)).toContain('cli/instance.js')
    expect(verifyRelease(outDir)).toEqual([])
    writeFileSync(join(outDir, 'cli', 'instance.js'), 'tampered')
    expect(verifyRelease(outDir)).toEqual([{ path: 'cli/instance.js', kind: 'mismatch' }])
    rmSync(join(outDir, 'cli', 'instance.js'))
    expect(verifyRelease(outDir)).toEqual([{ path: 'cli/instance.js', kind: 'missing' }])
  })
})

describe('D3/D6 published package.json', () => {
  it('has the bin, engines and one exact dependency equal to @vault/server-d1 wrangler (drift test, not a literal)', () => {
    const wrangler = readWranglerVersion(SERVER_D1_PKG)
    expect(wrangler).toBe(JSON.parse(readFileSync(SERVER_D1_PKG, 'utf8')).devDependencies.wrangler)
    const pkg = publishedPackageJson('0.1.0', wrangler) as Record<string, any>
    expect(pkg).toMatchObject({ name: 'vibase', version: '0.1.0', type: 'module', bin: { vibase: 'cli/vibase.js' }, engines: { node: '>=22' } })
    expect(pkg.dependencies).toEqual({ wrangler })
    expect(wrangler).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('readWranglerVersion refuses a range', () => {
    const d = mkdtempSync(join(tmpdir(), 'ops210-w-'))
    dirs.push(d)
    const p = join(d, 'package.json')
    require('node:fs').writeFileSync(p, JSON.stringify({ devDependencies: { wrangler: '^4.1.0' } }))
    expect(() => readWranglerVersion(p)).toThrow(/exact/)
  })
})

describe('D5 wrangler.base.jsonc', () => {
  const paths = { main: 'worker/worker.js', assetsDirectory: 'assets', migrationsDir: 'migrations' }
  it('is the top level of the source config: no env, no real ids, placeholder database_id, package-relative paths', () => {
    const base = deriveBaseConfig(readFileSync(WRANGLER_JSONC, 'utf8'), paths) as Record<string, any>
    expect(base.env).toBeUndefined()
    expect(base.main).toBe('worker/worker.js')
    expect(base.assets.directory).toBe('assets')
    expect(base.d1_databases[0].migrations_dir).toBe('migrations')
    expect(base.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000')
    const source = parse(readFileSync(WRANGLER_JSONC, 'utf8'))
    expect(Object.keys(base).sort()).toEqual(Object.keys(source).filter((k) => k !== 'env').sort())
    expect(base.triggers).toEqual(source.triggers)
  })
  it('the staged wrangler.base.jsonc parses and holds no env key', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
    dirs.push(s.root, outDir)
    stageRelease({ ...s, outDir })
    const base = parse(readFileSync(join(outDir, 'wrangler.base.jsonc'), 'utf8'))
    expect(base.env).toBeUndefined()
    expect(base.main).toBe('worker/worker.js')
  })
})
