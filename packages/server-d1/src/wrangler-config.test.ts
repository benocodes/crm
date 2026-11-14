import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPlatformProxy, unstable_readConfig } from 'wrangler'
import { UI_PAGE_PATHS, UI_PREFIX, UI_RUN_WORKER_FIRST } from './ui-serving.js'

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000'
const CONTROL_PLACEHOLDER = '00000000-0000-0000-0000-000000000001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// [[CORE259]] D1, D2: two bindings must be two databases locally. Through wrangler's own local proxy on the real config, a table made via DB is not visible via CONTROL_DB.
describe('the local DB and CONTROL_DB are separate databases', () => {
  it('a write through DB is not visible through CONTROL_DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-local-'))
    const proxy = await getPlatformProxy<{ DB: { prepare(q: string): { run(): Promise<unknown>; all(): Promise<unknown> } }; CONTROL_DB: { prepare(q: string): { all(): Promise<unknown> } } }>({ configPath: CONFIG, persist: { path: dir }, remoteBindings: false })
    try {
      await proxy.env.DB.prepare('create table only_in_crm (id text)').run()
      await expect(proxy.env.CONTROL_DB.prepare('select * from only_in_crm').all()).rejects.toThrow(/no such table/i)
    } finally {
      await proxy.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('wrangler.jsonc (OPS4 C2)', () => {
  it('the top level is unchanged and local-only', () => {
    const c = unstable_readConfig({ config: CONFIG })
    expect(c.name).toBe('vb')
    // [[CORE259]] D1: the control-plane database beside the CRM one, each with its own migrations directory.
    expect(c.d1_databases).toHaveLength(2)
    expect(c.d1_databases[0]!.binding).toBe('DB')
    expect(c.d1_databases[0]!.database_name).toBe('vb-crm')
    expect(c.d1_databases[0]!.database_id).toBe(PLACEHOLDER)
    expect(c.d1_databases[0]!.migrations_dir).toMatch(/storage-d1\/migrations$/)
    expect(c.d1_databases[1]!.binding).toBe('CONTROL_DB')
    expect(c.d1_databases[1]!.database_name).toBe('vb-control')
    // Its own placeholder: wrangler and Miniflare key a local database's SQLite file by database_id, so a shared id would make DB and CONTROL_DB one database.
    expect(c.d1_databases[1]!.database_id).toBe(CONTROL_PLACEHOLDER)
    expect(c.d1_databases[1]!.database_id).not.toBe(c.d1_databases[0]!.database_id)
    expect(c.d1_databases[1]!.migrations_dir).toMatch(/storage-d1\/control-migrations$/)
    expect(c.routes ?? []).toEqual([])
    expect(c.r2_buckets).toEqual([{ binding: 'BODIES', bucket_name: 'vb-bodies' }])
    expect(c.account_id).toBeUndefined()
  })

  it('env smoked1 has exactly the C2 shape', () => {
    const c = unstable_readConfig({ config: CONFIG, env: 'smoked1' })
    expect(c.name).toBe('vault-smoked1')
    expect(c.workers_dev).toBe(false)
    expect(c.preview_urls).toBe(false)
    expect(c.routes).toEqual([{ pattern: 'api.smoked1.vibase.ai', custom_domain: true }])
    expect(c.observability?.enabled).toBe(true)
    expect(c.d1_databases).toHaveLength(1)
    const db = c.d1_databases[0]!
    expect(db.binding).toBe('DB')
    expect(db.database_name).toBe('vault-smoked1')
    expect(db.remote).toBe(true)
    expect(db.migrations_dir).toMatch(/storage-d1\/migrations$/)
    expect(db.preview_database_id).toBeUndefined()
    expect(c.r2_buckets).toEqual([{ binding: 'BODIES', bucket_name: 'vault-smoked1-bodies' }])
    expect(c.vars).toEqual({ AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' })
    expect(c.account_id).toBeUndefined()
  })

  it('no deployed env binds CONTROL_DB yet (its database comes with OPS260), and each env keeps exactly its DB binding', () => {
    for (const env of ['smoked1', 'hq']) {
      const c = unstable_readConfig({ config: CONFIG, env })
      expect(c.d1_databases.map((d: { binding: string }) => d.binding), env).toEqual(['DB'])
    }
  })

  it('names no reserved production hostname or environment (D23)', () => {
    const text = readFileSync(CONFIG, 'utf8')
    for (const reserved of ['api.vibase.ai', 'app.vibase.ai', '"production"']) expect(text).not.toContain(reserved)
  })

  it('the smoked1 database id is a uuid', () => {
    const c = unstable_readConfig({ config: CONFIG, env: 'smoked1' })
    const id = c.d1_databases[0]!.database_id
    expect(id).toMatch(UUID)
    expect(id).not.toBe(PLACEHOLDER)
  })
})

// [[UI30]] D2: the connect page's assets, behind the Worker for /connect* only, in every env.
describe('assets (UI30 D2)', () => {
  // Every env the file declares (a fork has its own set; none is assumed), plus the top level.
  const declaredEnvs = Object.keys((parse(readFileSync(CONFIG, 'utf8')) as { env?: object }).env ?? {})
  it.each([undefined, ...declaredEnvs])('env %s binds ASSETS and runs the Worker first for /connect, /connect/*, the auth pages and /ui/* only (UI246 D2)', (env) => {
    const c = unstable_readConfig({ config: CONFIG, env })
    expect(c.assets?.binding).toBe('ASSETS')
    // Derived from the constants the Worker serves, never a copied list: a page or prefix the Worker serves but `run_worker_first` omits would be answered by the assets binding without the headers.
    expect(c.assets?.run_worker_first).toEqual(['/connect', '/connect/*', ...UI_RUN_WORKER_FIRST])
    for (const p of UI_PAGE_PATHS) expect(c.assets?.run_worker_first, p).toContain(p)
    expect(c.assets?.run_worker_first).toContain(`${UI_PREFIX}/*`)
    expect(resolve(dirname(CONFIG), c.assets!.directory!)).toMatch(/packages\/server-d1\/dist\/assets$/)
  })
})

// [[UI247]] D1: every list that must equal the constant, read from the real files (the release fixture and the setup fixture are strings and files that stay in step with `wrangler.jsonc` by hand).
describe('every run_worker_first list equals the constants the Worker serves (UI247 D1)', () => {
  const EXPECTED = ['/connect', '/connect/*', ...UI_RUN_WORKER_FIRST]
  const listIn = (text: string): unknown => (parse(text) as { assets?: { run_worker_first?: unknown } }).assets?.run_worker_first
  it('wrangler.jsonc lists the five pages and /ui/*', () => {
    expect(listIn(readFileSync(CONFIG, 'utf8'))).toEqual(EXPECTED)
    expect(UI_PAGE_PATHS).toContain('/consent')
    expect(UI_PAGE_PATHS).toContain('/device')
  })
  it("the setup fixture's list", () => {
    expect(listIn(readFileSync(fileURLToPath(new URL('../scripts/setup/test/wrangler.fixture.jsonc', import.meta.url)), 'utf8'))).toEqual(EXPECTED)
  })
  it("@vibase/release's fixtures.ts BASE_SOURCE", async () => {
    const { BASE_SOURCE } = await import('../../release/src/fixtures.js')
    expect(listIn(BASE_SOURCE)).toEqual(EXPECTED)
  })
})

// [[CHN141]] D34, D76: the Workflow and the cron are Worker configuration of the instance they run in. `workflows` and `triggers` are not
// inherited by an env, so each states its own; `hq` got its cron after the supervised first backfill ([[CHN155]] D92; it takes effect at the user's deploy).
// [[AGT8]] D54: every env also states the per-minute cron of the execution rail and the expiry sweep, beside the 15-minute one.
describe('mail sync Workflow and crons (CHN141 D34, D76; AGT8 D54)', () => {
  const CRONS = ['*/15 * * * *', '* * * * *']
  it.each([
    [undefined, 'vb-mail-sync', CRONS],
    ['smoked1', 'vault-smoked1-mail-sync', CRONS],
    ['hq', 'vault-hq-mail-sync', CRONS],
  ] as const)('env %s binds MAIL_SYNC to %s with crons %j', (env, name, crons) => {
    const c = unstable_readConfig({ config: CONFIG, env })
    expect(c.workflows).toEqual([expect.objectContaining({ binding: 'MAIL_SYNC', name, class_name: 'MailSyncWorkflow' })])
    expect(c.workflows).toHaveLength(1)
    expect(c.triggers?.crons ?? []).toEqual(crons)
  })
  it('the Worker entry exports the Workflow class the binding names', () => {
    expect(readFileSync(fileURLToPath(new URL('./worker.ts', import.meta.url)), 'utf8')).toMatch(/export \{[^}]*MailSyncWorkflow[^}]*\}/)
  })
})

// [[CORE243]] D2: Better Auth's bundle imports `node:*`, so the Worker runs with `nodejs_compat`. It is set at the top level and inherited by every env (`compatibility_flags` is
// an inheritable key), never dropped by an env of its own: a deploy whose bundle has `node:` imports and no flag fails only remotely.
describe('nodejs_compat (CORE243 D2)', () => {
  const declaredEnvs = Object.keys((parse(readFileSync(CONFIG, 'utf8')) as { env?: object }).env ?? {})
  it.each([undefined, ...declaredEnvs])('env %s runs with nodejs_compat', (env) => {
    expect(unstable_readConfig({ config: CONFIG, env }).compatibility_flags).toContain('nodejs_compat')
  })
  it('no env states a compatibility_flags list of its own (so none can leave the flag out)', () => {
    const envs = (parse(readFileSync(CONFIG, 'utf8')) as { env?: Record<string, Record<string, unknown>> }).env ?? {}
    for (const [name, block] of Object.entries(envs)) expect(block.compatibility_flags, name).toBeUndefined()
  })
  it('the comment no longer says there is no nodejs_compat', () => {
    expect(readFileSync(CONFIG, 'utf8')).not.toContain('No nodejs_compat')
  })
})
