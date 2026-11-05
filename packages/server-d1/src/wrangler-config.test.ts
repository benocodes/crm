import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { unstable_readConfig } from 'wrangler'

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('wrangler.jsonc (OPS4 C2)', () => {
  it('the top level is unchanged and local-only', () => {
    const c = unstable_readConfig({ config: CONFIG })
    expect(c.name).toBe('vault')
    expect(c.d1_databases).toHaveLength(1)
    expect(c.d1_databases[0]!.database_id).toBe(PLACEHOLDER)
    expect(c.routes ?? []).toEqual([])
    expect(c.r2_buckets).toEqual([{ binding: 'BODIES', bucket_name: 'vault-bodies' }])
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
  it.each([undefined, ...declaredEnvs])('env %s binds ASSETS and runs the Worker first for /connect and /connect/* only', (env) => {
    const c = unstable_readConfig({ config: CONFIG, env })
    expect(c.assets?.binding).toBe('ASSETS')
    expect(c.assets?.run_worker_first).toEqual(['/connect', '/connect/*'])
    expect(resolve(dirname(CONFIG), c.assets!.directory!)).toMatch(/packages\/server-d1\/dist\/assets$/)
  })
})

// [[CHN141]] D34, D76: the Workflow and the cron are Worker configuration of the instance they run in. `workflows` and `triggers` are not
// inherited by an env, so each states its own; `hq` has the binding and no cron until the supervised first backfill.
describe('mail sync Workflow and cron (CHN141 D34, D76)', () => {
  const CRON = '*/15 * * * *'
  it.each([
    [undefined, 'vault-mail-sync', [CRON]],
    ['smoked1', 'vault-smoked1-mail-sync', [CRON]],
    ['hq', 'vault-hq-mail-sync', []],
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
