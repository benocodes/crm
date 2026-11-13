import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { sources } from './fixtures.js'
import { listFiles, verifyRelease } from './manifest.js'
import { clientPackageJson, deriveBaseConfig, readWranglerVersion, serverPackageJson, stageClient, stageServer } from './stage.js'

const SERVER_D1_PKG = new URL('../../server-d1/package.json', import.meta.url).pathname
const WRANGLER_JSONC = new URL('../../server-d1/wrangler.jsonc', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('D3 layout', () => {
  it('the staged package holds exactly the cycle-1 files', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
    dirs.push(s.root, outDir)
    stageServer({ ...s, outDir })
    expect(listFiles(outDir)).toEqual([
      'LICENSE', 'README.md', 'assets/connect/connect.js', 'assets/connect/index.html', 'cli/server.js',
      'control-migrations/0001_c.sql', 'control-migrations/0002_d.sql', 'migrations/0001_a.sql', 'migrations/0002_b.sql', 'package.json', 'release.json', 'worker/worker.js', 'wrangler.base.jsonc',
    ])
  })
})

describe('OPS240 D3 the client package', () => {
  it('holds exactly package.json, cli/vibase.js, LICENSE and README.md: no release.json, no worker, assets or migrations', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops240-client-'))
    dirs.push(s.root, outDir)
    stageClient({ ...s, outDir })
    expect(listFiles(outDir)).toEqual(['LICENSE', 'README.md', 'cli/vibase.js', 'package.json'])
    expect(readFileSync(join(outDir, 'cli', 'vibase.js'), 'utf8')).toBe(readFileSync(s.cliJs, 'utf8'))
    expect(readFileSync(join(outDir, 'README.md'), 'utf8')).toBe(s.clientReadme)
  })
  it('the server package holds no client: no cli/vibase.js', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops240-server-'))
    dirs.push(s.root, outDir)
    stageServer({ ...s, outDir })
    expect(listFiles(outDir)).not.toContain('cli/vibase.js')
    expect(readFileSync(join(outDir, 'README.md'), 'utf8')).toBe(s.serverReadme)
  })
})

describe('D12 cli/server.js', () => {
  it('is staged and covered by release.json files (so verify refuses a tampered or removed one)', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops231-out-'))
    dirs.push(s.root, outDir)
    const manifest = stageServer({ ...s, outDir })
    expect(Object.keys(manifest.files)).toContain('cli/server.js')
    expect(verifyRelease(outDir)).toEqual([])
    writeFileSync(join(outDir, 'cli', 'server.js'), 'tampered')
    expect(verifyRelease(outDir)).toEqual([{ path: 'cli/server.js', kind: 'mismatch' }])
    rmSync(join(outDir, 'cli', 'server.js'))
    expect(verifyRelease(outDir)).toEqual([{ path: 'cli/server.js', kind: 'missing' }])
  })
})

describe('D3/D6 published package.json', () => {
  it('has the bin, engines and one exact dependency equal to @vibase/server-d1 wrangler (drift test, not a literal)', () => {
    const wrangler = readWranglerVersion(SERVER_D1_PKG)
    expect(wrangler).toBe(JSON.parse(readFileSync(SERVER_D1_PKG, 'utf8')).devDependencies.wrangler)
    const pkg = serverPackageJson('0.1.0', wrangler) as Record<string, any>
    expect(pkg).toMatchObject({ name: '@vibase/server-d1', version: '0.1.0', type: 'module', bin: { 'vibase-server': 'cli/server.js' }, engines: { node: '>=22' }, publishConfig: { access: 'public' } })
    expect(Object.keys(pkg.bin)).toEqual(['vibase-server'])
    expect(pkg.dependencies).toEqual({ wrangler })
    expect(wrangler).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('OPS240 D22: the client package.json is @vibase/cli with bin vibase, engines, public access and no dependencies of any kind', () => {
    const pkg = clientPackageJson('0.1.0') as Record<string, any>
    expect(pkg).toMatchObject({ name: '@vibase/cli', version: '0.1.0', type: 'module', bin: { vibase: 'cli/vibase.js' }, engines: { node: '>=22' }, publishConfig: { access: 'public' } })
    expect(Object.keys(pkg.bin)).toEqual(['vibase'])
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'scripts', 'exports']) expect(pkg[k], k).toBeUndefined()
  })
  it('OPS240 D23 (a): the server exports are exactly the seven stable paths (OPS260: control-migrations/* is additive)', () => {
    const pkg = serverPackageJson('0.1.0', '4.149.0') as Record<string, any>
    expect(pkg.exports).toEqual({
      './worker': './worker/worker.js',
      './wrangler.base.jsonc': './wrangler.base.jsonc',
      './release.json': './release.json',
      './migrations/*': './migrations/*',
      './control-migrations/*': './control-migrations/*',
      './assets/*': './assets/*',
      './package.json': './package.json',
    })
  })
  it('the staged package.json files are the templates filled with the one version: both equal, the server release.json names @vibase/server-d1', () => {
    const s = sources()
    const c = mkdtempSync(join(tmpdir(), 'ops240-c-'))
    const v = mkdtempSync(join(tmpdir(), 'ops240-v-'))
    dirs.push(s.root, c, v)
    stageClient({ ...s, outDir: c })
    const manifest = stageServer({ ...s, outDir: v })
    const cp = JSON.parse(readFileSync(join(c, 'package.json'), 'utf8'))
    const sp = JSON.parse(readFileSync(join(v, 'package.json'), 'utf8'))
    expect(cp).toEqual(clientPackageJson(s.version))
    expect(sp).toEqual(serverPackageJson(s.version, s.wranglerVersion))
    expect(cp.version).toBe(sp.version)
    expect(manifest.name).toBe('@vibase/server-d1')
  })
  it('the README templates exist: the client names @vibase/cli and no wrangler, the server names the npx form', () => {
    const t = new URL('../templates/', import.meta.url).pathname
    const client = readFileSync(join(t, 'cli-README.md'), 'utf8')
    const server = readFileSync(join(t, 'server-d1-README.md'), 'utf8')
    expect(client).toMatch(/@vibase\/cli/)
    expect(client).not.toMatch(/wrangler/i)
    expect(client).not.toMatch(/vibase instance/)
    expect(server).toMatch(/npx @vibase\/server-d1@<version> (setup|status)/)
    expect(server).toMatch(/vibase-server/)
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
  const paths = { main: 'worker/worker.js', assetsDirectory: 'assets', migrationsDir: 'migrations', controlMigrationsDir: 'control-migrations' }
  it('is the top level of the source config: no env, no real ids, placeholder database_id, package-relative paths', () => {
    const base = deriveBaseConfig(readFileSync(WRANGLER_JSONC, 'utf8'), paths) as Record<string, any>
    expect(base.env).toBeUndefined()
    expect(base.main).toBe('worker/worker.js')
    expect(base.assets.directory).toBe('assets')
    expect(base.d1_databases[0].migrations_dir).toBe('migrations')
    expect(base.d1_databases[1]).toMatchObject({ binding: 'CONTROL_DB', migrations_dir: 'control-migrations' })
    expect(base.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000')
    const source = parse(readFileSync(WRANGLER_JSONC, 'utf8'))
    expect(Object.keys(base).sort()).toEqual(Object.keys(source).filter((k) => k !== 'env').sort())
    expect(base.triggers).toEqual(source.triggers)
  })
  it('carries the nodejs_compat flag of the source config (CORE243 D2), so a deploy of the shipped Worker has it', () => {
    const base = deriveBaseConfig(readFileSync(WRANGLER_JSONC, 'utf8'), paths) as Record<string, any>
    expect(base.compatibility_flags).toContain('nodejs_compat')
  })
  it('the staged wrangler.base.jsonc parses and holds no env key', () => {
    const s = sources()
    const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
    dirs.push(s.root, outDir)
    stageServer({ ...s, outDir })
    const base = parse(readFileSync(join(outDir, 'wrangler.base.jsonc'), 'utf8'))
    expect(base.env).toBeUndefined()
    expect(base.main).toBe('worker/worker.js')
  })
})
