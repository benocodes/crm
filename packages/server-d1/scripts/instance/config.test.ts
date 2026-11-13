import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { PLACEHOLDER_DATABASE_ID, RemoteRefusal, resolveTarget } from '../remote.js'
import { generateConfig, withGeneratedConfig } from './config.js'
import { parseSettings } from './settings.js'
import { ACCOUNT, cleanup, mkTmp, stagedPackage, TOKEN, UUID, validSettings } from './test-kit.js'

afterEach(cleanup)
const settings = (over: Record<string, unknown> = {}) => parseSettings(JSON.stringify(validSettings(over)), 'demo', '/s.json')
const paths = { worker: '/pkg/worker/worker.js', assets: '/pkg/assets', migrations: '/pkg/migrations' }
const base = () => parse(readFileSync(join(stagedPackage().dir, 'wrangler.base.jsonc'), 'utf8')) as Record<string, any>

describe('D11 generated config', () => {
  it('carries the settings and the installed absolute paths, with remote: true on DB', () => {
    const c = generateConfig(base(), settings(), paths)
    expect(c.name).toBe('vault-demo')
    expect(c.main).toBe(paths.worker)
    expect(c.assets.directory).toBe(paths.assets)
    expect(c.d1_databases).toEqual([{ binding: 'DB', database_name: 'vault-demo', database_id: UUID, migrations_dir: paths.migrations, remote: true }])
    expect(c.r2_buckets).toEqual([{ binding: 'BODIES', bucket_name: 'vault-demo-bodies' }])
    expect(c.workflows).toEqual([{ binding: 'MAIL_SYNC', name: 'vault-demo-mail-sync', class_name: 'MailSyncWorkflow' }])
    expect(c.vars).toEqual({ AUTH_PROVIDER: '' })
    expect(c.compatibility_date).toBe(base().compatibility_date)
    expect(c.triggers).toEqual(base().triggers)
    expect(c.env).toBeUndefined()
  })
  it('keeps the base config\'s nodejs_compat flag: the config a deploy uses has it (CORE243 D2)', () => {
    expect(base().compatibility_flags).toContain('nodejs_compat')
    expect(generateConfig(base(), settings(), paths).compatibility_flags).toContain('nodejs_compat')
  })
  it('settings crons replace the base crons; api_host becomes the custom-domain route', () => {
    const c = generateConfig(base(), settings({ crons: ['* * * * *'] }), paths)
    expect(c.triggers).toEqual({ crons: ['* * * * *'] })
    expect(c.routes).toEqual([{ pattern: 'api.demo.invalid', custom_domain: true }])
  })
  it('passes resolveTarget (D11: the OPS4 C4 refusals apply)', () => {
    expect(resolveTarget(generateConfig(base(), settings(), paths), 'demo')).toMatchObject({ workerName: 'vault-demo', databaseId: UUID })
  })
  it('resolveTarget refuses a generated config with the placeholder id', () => {
    const s = settings()
    s.d1.id = PLACEHOLDER_DATABASE_ID
    expect(() => resolveTarget(generateConfig(base(), s, paths), 'demo')).toThrow(RemoteRefusal)
    expect(() => resolveTarget(generateConfig(base(), s, paths), 'demo')).toThrow(/placeholder/)
  })
  it('resolveTarget refuses a non-remote binding and the local worker name', () => {
    const c = generateConfig(base(), settings(), paths)
    c.d1_databases[0].remote = false
    expect(() => resolveTarget(c, 'demo')).toThrow(/remote: true/)
    expect(() => resolveTarget(generateConfig(base(), settings({ worker: 'vb' }), paths), 'demo')).toThrow(/unknown env/)
  })
  it('contains no secret value', () => {
    const text = JSON.stringify(generateConfig(base(), settings(), paths))
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(ACCOUNT)
  })
})

describe('D11 temp directory', () => {
  it('writes the config with absolute installed paths into a fresh temp dir and deletes it after success', () => {
    const pkg = stagedPackage()
    const root = mkTmp()
    let seen = ''
    let dir = ''
    const r = withGeneratedConfig({ packageDir: pkg.dir, settings: settings(), tmpRoot: root }, (p) => {
      dir = join(p, '..')
      expect(dir.startsWith(root)).toBe(true)
      seen = readFileSync(p, 'utf8')
      return 42
    })
    expect(r).toBe(42)
    const c = JSON.parse(seen)
    expect(c.main).toBe(join(pkg.dir, 'worker', 'worker.js'))
    expect(c.assets.directory).toBe(join(pkg.dir, 'assets'))
    expect(c.d1_databases[0].migrations_dir).toBe(join(pkg.dir, 'migrations'))
    expect(c.d1_databases[0].remote).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })
  it('the resources-only config of `setup` also refuses the local top-level worker name (OPS262 D3), and a real name passes', () => {
    const root = mkTmp()
    const run = (worker: string) => withGeneratedConfig({ packageDir: stagedPackage().dir, settings: settings({ worker }), tmpRoot: root, resourcesOnly: true }, () => 'ran')
    expect(() => run('vb')).toThrow(/unknown env demo/)
    expect(run('vb-demo')).toBe('ran')
    expect(readdirSync(root)).toEqual([])
  })
  it('deletes it when the callback throws', () => {
    const root = mkTmp()
    expect(() => withGeneratedConfig({ packageDir: stagedPackage().dir, settings: settings(), tmpRoot: root }, () => { throw new Error('boom') })).toThrow('boom')
    expect(readdirSync(root)).toEqual([])
  })
  it('never writes into the package or the settings directory', () => {
    const pkg = stagedPackage()
    const before = readdirSync(pkg.dir).sort()
    withGeneratedConfig({ packageDir: pkg.dir, settings: settings(), tmpRoot: mkTmp() }, () => 0)
    expect(readdirSync(pkg.dir).sort()).toEqual(before)
  })
  it('refuses (resolveTarget) a settings object with the placeholder id before any file is written', () => {
    const root = mkTmp()
    const s = settings()
    s.d1.id = PLACEHOLDER_DATABASE_ID
    expect(() => withGeneratedConfig({ packageDir: stagedPackage().dir, settings: s, tmpRoot: root }, () => 0)).toThrow(RemoteRefusal)
    expect(readdirSync(root)).toEqual([])
  })
})
