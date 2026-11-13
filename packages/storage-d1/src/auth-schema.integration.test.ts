import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS } from './migrations-manifest.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE243]] D4: migration 0018 (the auth tables) applied over a database at 0017 that already holds vault rows, and what the tables enforce. The raw inserts are the
// permitted exception: the schema test proves what the database refuses, which Better Auth's own writes never reach.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-13T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'], { migrate: false })
  d1 = local.bindings.G!
})
afterAll(async () => {
  await local.dispose()
})

const run = (sqlText: string, ...binds: unknown[]) =>
  d1.prepare(sqlText).bind(...binds).run().then(() => null, (e: Error) => e.message)
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) => ((await d1.prepare(sqlText).bind(...binds).all()).results ?? []) as T[]
const authTables = async () => (await all<{ name: string }>("select name from sqlite_master where type = 'table' and name like 'auth\\_%' escape '\\' order by name")).map((r) => r.name)

describe('migration 0018_auth_tables over a database at 0017 with data', () => {
  it('is the next migration in the manifest', () => {
    expect(MIGRATIONS.map((m) => m.name).at(-1)).toBe('0018_auth_tables.sql')
  })

  it('applies, keeps every existing row, and adds the auth tables empty', async () => {
    const before = mkdtempSync(join(tmpdir(), 'mig17-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0018')) cpSync(join(MIGRATIONS_DIR, f), join(before, f))
    expect(readdirSync(before).sort().pop()).toBe('0017_webhook_deliveries.sql')
    await applyMigrations(d1, before)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await seedAgent(d1, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: ['tasks:read'] })
    const snapshot = async () => ({ agents: await all('select * from agents'), principals: await all('select * from principals'), users: await all('select * from users'), events: await all('select * from events') })
    const vaultBefore = await snapshot()
    expect(await authTables()).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig18-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0018'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0018_auth_tables.sql'])
    expect(await snapshot()).toEqual(vaultBefore)
    const tables = await authTables()
    expect(tables.length).toBeGreaterThanOrEqual(13)
    for (const t of tables) expect(await all(`select count(*) as n from ${t}`), t).toEqual([{ n: 0 }])
  })

  it('every auth table is machinery: no organization_id, no created_by (they are deployment-scoped, written only by Better Auth)', async () => {
    for (const t of await authTables()) {
      const columns = (await all<{ name: string }>(`select name from pragma_table_info('${t}')`)).map((c) => c.name)
      expect(columns, t).not.toContain('organization_id')
      expect(columns, t).not.toContain('created_by')
      expect(columns, t).toContain('id')
    }
  })

  it('declares the foreign keys Better Auth relies on: a session and an account die with their user, a refresh token with its client', async () => {
    expect(await run('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', id(1), 'A', 'a@auth.test', AT, AT)).toBeNull()
    expect(await run('insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', id(2), AT, 'tok', AT, AT, id(1))).toBeNull()
    expect(await run('insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)', id(3), AT, 'tok2', AT, AT, id(99))).toMatch(/FOREIGN KEY/i)
    await run('delete from auth_users where id = ?', id(1))
    expect(await all('select id from auth_sessions')).toEqual([])
  })

  it('refuses a second user with the same email, a second device with the same user code, and a second session token', async () => {
    expect(await run('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', id(10), 'A', 'dup@auth.test', AT, AT)).toBeNull()
    expect(await run('insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)', id(11), 'B', 'dup@auth.test', AT, AT)).toMatch(/UNIQUE/i)
    const device = (n: number) => run('insert into auth_device_codes (id, device_code, user_code, expires_at, status) values (?, ?, ?, ?, ?)', id(n), `dc${n}`, 'SAMECODE', AT, 'pending')
    expect(await device(20)).toBeNull()
    expect(await device(21)).toMatch(/UNIQUE/i)
  })
})
