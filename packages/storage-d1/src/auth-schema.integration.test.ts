import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS } from './migrations-manifest.js'
import { MIGRATIONS_DIR, applyControlMigrations, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE243]] D4, [[CORE259]] D13, [[OPS260]]: the auth tables' DDL is proven on the CONTROL database (control 0001 carries it). The CRM database got them from migration 0018 (dormant) and
// loses them in 0019: that migration is applied here over a database at 0018 that holds vault rows AND a row in every auth table. The raw inserts are the permitted exception: the schema
// test proves what the database refuses, which Better Auth's own writes never reach.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-13T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

let local: LocalD1
let d1: D1Like
let crm: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONTROL', 'CRM'], { migrate: false })
  d1 = local.bindings.CONTROL!
  crm = local.bindings.CRM!
  await applyControlMigrations(d1)
})
afterAll(async () => {
  await local.dispose()
})

const runOn = (db: D1Like, sqlText: string, ...binds: unknown[]) => db.prepare(sqlText).bind(...binds).run().then(() => null, (e: Error) => e.message)
const allOn = async <T = Record<string, unknown>>(db: D1Like, sqlText: string, ...binds: unknown[]) => ((await db.prepare(sqlText).bind(...binds).all()).results ?? []) as T[]
const run = (sqlText: string, ...binds: unknown[]) => runOn(d1, sqlText, ...binds)
const all = <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) => allOn<T>(d1, sqlText, ...binds)
const authTablesOf = async (db: D1Like) => (await allOn<{ name: string }>(db, "select name from sqlite_master where type = 'table' and name like 'auth\\_%' escape '\\' order by name")).map((r) => r.name)
const authTables = () => authTablesOf(d1)

/** One row in every auth table, parents first: the 14 tables, with the foreign keys 0018 declares in use. */
async function seedEveryAuthTable(db: D1Like): Promise<void> {
  const rows: Array<[string, unknown[]]> = [
    ['insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', [id(1), 'A', 'seed@auth.test', AT, AT]],
    ['insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', [id(2), AT, 'seed-token', AT, AT, id(1)]],
    ['insert into auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', [id(3), 'acc', 'credential', id(1), AT, AT]],
    ['insert into auth_verifications (id, identifier, value, expires_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', [id(4), 'reset-password:x', 'v', AT, AT, AT]],
    ['insert into auth_jwks (id, public_key, private_key, created_at) values (?, ?, ?, ?)', [id(5), 'pub', 'priv', AT]],
    ['insert into auth_oauth_clients (id, client_id, redirect_uris, user_id) values (?, ?, ?, ?)', [id(6), 'seed-client', '[]', id(1)]],
    ['insert into auth_oauth_resources (id, identifier, name) values (?, ?, ?)', [id(7), 'seed-resource', 'R']],
    ['insert into auth_oauth_client_resources (id, client_id, resource_id) values (?, ?, ?)', [id(8), 'seed-client', 'seed-resource']],
    ['insert into auth_oauth_refresh_tokens (id, token, client_id, session_id, user_id, expires_at, created_at, scopes) values (?, ?, ?, ?, ?, ?, ?, ?)', [id(9), 'seed-rt', 'seed-client', id(2), id(1), AT, AT, 'openid']],
    ['insert into auth_oauth_access_tokens (id, token, client_id, session_id, user_id, refresh_id, expires_at, created_at, scopes) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id(10), 'seed-at', 'seed-client', id(2), id(1), id(9), AT, AT, 'openid']],
    ['insert into auth_oauth_consents (id, client_id, user_id, scopes, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', [id(11), 'seed-client', id(1), 'openid', AT, AT]],
    ['insert into auth_oauth_client_assertions (id, expires_at) values (?, ?)', [id(12), AT]],
    ['insert into auth_device_codes (id, device_code, user_code, expires_at, status) values (?, ?, ?, ?, ?)', [id(13), 'dc', 'UC', AT, 'pending']],
    ['insert into auth_rate_limits (id, key, count, last_request) values (?, ?, ?, ?)', [id(14), 'k', 1, 1]],
  ]
  for (const [text, binds] of rows) expect(await runOn(db, text, ...binds), text).toBeNull()
}
const counts = async (db: D1Like) => Object.fromEntries(await Promise.all((await authTablesOf(db)).map(async (t) => [t, ((await allOn<{ n: number }>(db, `select count(*) as n from ${t}`))[0]!).n] as const)))

describe('migration 0019 drops the CRM database auth tables (D13), over data', () => {
  it('is the next migration in the manifest', () => {
    expect(MIGRATIONS.map((m) => m.name).at(-1)).toBe('0019_drop_auth_tables.sql')
  })

  it('a CRM database at 0018 with a row in every auth table and vault rows applies 0019: no auth table is left, the vault rows stay, and the control database is untouched', async () => {
    const before = mkdtempSync(join(tmpdir(), 'mig18-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0019')) cpSync(join(MIGRATIONS_DIR, f), join(before, f))
    expect(readdirSync(before).sort().pop()).toBe('0018_auth_tables.sql')
    await applyMigrations(crm, before)
    await seedDeployment(crm, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(crm, { id: USER, kind: 'user' })
    await seedAgent(crm, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: ['tasks:read'] })
    await seedEveryAuthTable(crm)
    await seedEveryAuthTable(d1)
    expect(await authTablesOf(crm)).toHaveLength(14)
    const vault = async () => ({ agents: await allOn(crm, 'select * from agents'), principals: await allOn(crm, 'select * from principals'), users: await allOn(crm, 'select * from users'), events: await allOn(crm, 'select * from events'), deployment: await allOn(crm, 'select * from deployment') })
    const vaultBefore = await vault()
    const controlBefore = await counts(d1)
    expect(Object.values(controlBefore).every((n) => n === 1)).toBe(true)

    const only = mkdtempSync(join(tmpdir(), 'mig19-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0019'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(crm, only)).toEqual(['0019_drop_auth_tables.sql'])

    expect(await authTablesOf(crm)).toEqual([])
    expect(await vault()).toEqual(vaultBefore)
    expect(await counts(d1)).toEqual(controlBefore)
    expect((await authTables()).length).toBe(14)
  })

  it('the whole CRM directory leaves no auth table in a fresh database, and the control directory has the 14', async () => {
    const fresh = await openLocalD1(['F'])
    try {
      expect(await authTablesOf(fresh.bindings.F!)).toEqual([])
    } finally {
      await fresh.dispose()
    }
    expect(await authTables()).toHaveLength(14)
  })
})

describe('the auth tables on the control database (moved from the CRM checks of 0018)', () => {
  it('every auth table is machinery: no organization_id, no created_by (they are deployment-scoped, written only by Better Auth)', async () => {
    for (const t of await authTables()) {
      const columns = (await all<{ name: string }>(`select name from pragma_table_info('${t}')`)).map((c) => c.name)
      expect(columns, t).not.toContain('organization_id')
      expect(columns, t).not.toContain('created_by')
      expect(columns, t).toContain('id')
    }
  })

  it('declares the foreign keys Better Auth relies on: a session and an account die with their user, a refresh token with its client', async () => {
    expect(await run('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', id(41), 'A', 'a@auth.test', AT, AT)).toBeNull()
    expect(await run('insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', id(42), AT, 'tok', AT, AT, id(41))).toBeNull()
    expect(await run('insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', id(43), AT, 'tok2', AT, AT, id(99))).toMatch(/FOREIGN KEY/i)
    expect(await run('insert into auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', id(44), 'acc2', 'credential', id(41), AT, AT)).toBeNull()
    expect(await run('insert into auth_oauth_clients (id, client_id, redirect_uris) values (?, ?, ?)', id(45), 'client-1', '[]')).toBeNull()
    expect(await run('insert into auth_oauth_refresh_tokens (id, token, client_id, user_id, expires_at, created_at, scopes) values (?, ?, ?, ?, ?, ?, ?)', id(46), 'rt', 'client-1', id(41), AT, AT, 'openid')).toBeNull()
    await run('delete from auth_oauth_clients where client_id = ?', 'client-1')
    expect(await all('select id from auth_oauth_refresh_tokens where id = ?', id(46))).toEqual([])
    await run('delete from auth_users where id = ?', id(41))
    expect(await all('select id from auth_sessions where id = ?', id(42))).toEqual([])
    expect(await all('select id from auth_accounts where id = ?', id(44))).toEqual([])
  })

  it('refuses a second user with the same email, a second device with the same user code, and a second session token', async () => {
    expect(await run('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', id(50), 'A', 'dup@auth.test', AT, AT)).toBeNull()
    expect(await run('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', id(51), 'B', 'dup@auth.test', AT, AT)).toMatch(/UNIQUE/i)
    expect(await run('insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', id(52), AT, 'same-token', AT, AT, id(50))).toBeNull()
    expect(await run('insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', id(53), AT, 'same-token', AT, AT, id(50))).toMatch(/UNIQUE/i)
    const device = (n: number) => run('insert into auth_device_codes (id, device_code, user_code, expires_at, status) values (?, ?, ?, ?, ?)', id(n), `dc${n}`, 'SAMECODE', AT, 'pending')
    expect(await device(60)).toBeNull()
    expect(await device(61)).toMatch(/UNIQUE/i)
  })
})
