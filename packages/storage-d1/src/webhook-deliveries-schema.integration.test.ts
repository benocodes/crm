import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// API219 (D14, D20): migration 0017 applied over a database at 0016 that already holds subscriptions, and what `webhook_deliveries` refuses. The raw inserts are the permitted
// exception: the schema test proves what the database refuses, which no operation reaches.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-12T09:00:00.000Z'
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

const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return d1.batch([d1.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row))]).then(() => null, (e: Error) => e.message)
}
const run = (sqlText: string, ...binds: unknown[]) => d1.prepare(sqlText).bind(...binds).run().then(() => null, (e: Error) => e.message)
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) => ((await d1.prepare(sqlText).bind(...binds).all()).results ?? []) as T[]
const sub = (over: Record<string, unknown> = {}) => ({ id: id(1), created_at: AT, updated_at: AT, organization_id: ORG, created_by: USER, agent_id: AGENT, url: 'https://example.com/hook', event_types: '["task.created"]', status: 'active', ...over })
const delivery = (over: Record<string, unknown> = {}) => ({ id: id(50), created_at: AT, organization_id: ORG, created_by: USER, subscription_id: id(1), event_id: id(60), event_type: 'task.created', status: 'pending', attempts: 0, next_attempt_at: AT, ...over })

describe('migration 0017_webhook_deliveries over a database at 0016 with data', () => {
  it('applies, keeps every existing row, and adds the table empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0017')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0016_webhooks.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await seedAgent(d1, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: ['tasks:read'] })
    expect(await insert('webhook_subscriptions', sub())).toBeNull()
    const snapshot = async () => ({ subs: await all('select * from webhook_subscriptions'), agents: await all('select * from agents'), events: await all('select * from events') })
    const before = await snapshot()
    expect(await all("select name from sqlite_master where name = 'webhook_deliveries'")).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig17-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0017'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0017_webhook_deliveries.sql'])
    expect(await snapshot()).toEqual(before)
    expect(await all('select count(*) as n from webhook_deliveries')).toEqual([{ n: 0 }])
  })

  it('status, attempts, ids and timestamps are checked; the four statuses are accepted', async () => {
    expect(await insert('webhook_deliveries', delivery({ status: 'sent' }))).toMatch(/webhook_deliveries_status/)
    expect(await insert('webhook_deliveries', delivery({ attempts: -1 }))).toMatch(/CHECK/)
    expect(await insert('webhook_deliveries', delivery({ id: 'x' }))).toMatch(/CHECK/)
    expect(await insert('webhook_deliveries', delivery({ next_attempt_at: 'soon' }))).toMatch(/CHECK/)
    expect(await insert('webhook_deliveries', delivery({ delivered_at: 'later' }))).toMatch(/CHECK/)
    expect(await insert('webhook_deliveries', delivery({ last_attempt_at: 'later' }))).toMatch(/CHECK/)
    expect(await insert('webhook_deliveries', delivery({ event_type: null }))).toMatch(/NOT NULL/)
    expect(await insert('webhook_deliveries', delivery({ event_id: null }))).toMatch(/NOT NULL/)
    expect(await insert('webhook_deliveries', delivery({ next_attempt_at: null }))).toMatch(/NOT NULL/)
    let n = 0
    for (const status of ['pending', 'delivered', 'dead', 'cancelled']) {
      expect(await insert('webhook_deliveries', delivery({ id: id(70 + n), event_id: id(80 + n), status })), status).toBeNull()
      n++
    }
    expect(await run('DELETE FROM webhook_deliveries')).toBeNull()
  })

  it('the pair (subscription, event) is unique: a second row for it is refused, a second event or a second subscription is not', async () => {
    expect(await insert('webhook_deliveries', delivery())).toBeNull()
    expect(await insert('webhook_deliveries', delivery({ id: id(51) }))).toMatch(/UNIQUE/)
    expect(await insert('webhook_deliveries', delivery({ id: id(52), event_id: id(61) }))).toBeNull()
    expect(await insert('webhook_subscriptions', sub({ id: id(2) }))).toBeNull()
    expect(await insert('webhook_deliveries', delivery({ id: id(53), subscription_id: id(2) }))).toBeNull()
    // ON CONFLICT DO NOTHING is how the dispatcher relies on it
    expect(await run('INSERT INTO webhook_deliveries (id, created_at, organization_id, created_by, subscription_id, event_id, event_type, status, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (subscription_id, event_id) DO NOTHING', id(54), AT, ORG, USER, id(1), id(60), 'task.created', 'pending', 0, AT)).toBeNull()
    expect((await all('select count(*) as n from webhook_deliveries'))[0]).toEqual({ n: 3 })
    expect(await run('DELETE FROM webhook_deliveries')).toBeNull()
  })

  it('the lease columns are both or neither, and only a pending row holds a lease', async () => {
    expect(await insert('webhook_deliveries', delivery({ lease_until: AT }))).toMatch(/webhook_deliveries_lease/)
    expect(await insert('webhook_deliveries', delivery({ lease_token: 'tok' }))).toMatch(/webhook_deliveries_lease/)
    expect(await insert('webhook_deliveries', delivery({ lease_until: 'soon', lease_token: 'tok' }))).toMatch(/CHECK/)
    expect(await insert('webhook_deliveries', delivery({ status: 'delivered', lease_until: AT, lease_token: 'tok' }))).toMatch(/webhook_deliveries_lease/)
    expect(await insert('webhook_deliveries', delivery({ status: 'dead', lease_until: AT, lease_token: 'tok' }))).toMatch(/webhook_deliveries_lease/)
    expect(await insert('webhook_deliveries', delivery({ lease_until: AT, lease_token: 'tok' }))).toBeNull()
    expect(await run("UPDATE webhook_deliveries SET status = 'delivered' WHERE id = ?", id(50))).toMatch(/webhook_deliveries_lease/)
    expect(await run("UPDATE webhook_deliveries SET status = 'delivered', lease_until = NULL, lease_token = NULL WHERE id = ?", id(50))).toBeNull()
    expect(await run('DELETE FROM webhook_deliveries')).toBeNull()
  })

  it('the foreign keys refuse a missing subscription (composite with the organisation), creator or organisation; event_id has no foreign key', async () => {
    expect(await insert('webhook_deliveries', delivery({ subscription_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_deliveries', delivery({ created_by: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_deliveries', delivery({ organization_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_deliveries', delivery({ event_id: id(99) }))).toBeNull() // an event id is a position, not a reference
    const fks = await all<{ table: string; from: string }>("select \"table\", \"from\" from pragma_foreign_key_list('webhook_deliveries') order by \"table\", \"from\"")
    expect(fks.filter((f) => f.table === 'webhook_subscriptions').map((f) => f.from).sort()).toEqual(['organization_id', 'subscription_id'])
    expect(fks.some((f) => f.table === 'events')).toBe(false)
    expect(await run('DELETE FROM webhook_deliveries')).toBeNull()
  })

  it('has the due index (partial on pending) and the list index of the plan', async () => {
    const idx = await all<{ name: string; partial: number }>("select name, partial from pragma_index_list('webhook_deliveries') where name like 'idx_%' order by name")
    expect(idx).toEqual([
      { name: 'idx_webhook_deliveries_due', partial: 1 },
      { name: 'idx_webhook_deliveries_list', partial: 0 },
    ])
    expect((await all<{ name: string }>("select name from pragma_index_info('idx_webhook_deliveries_due') order by seqno")).map((c) => c.name)).toEqual(['next_attempt_at', 'id'])
    expect((await all<{ name: string }>("select name from pragma_index_info('idx_webhook_deliveries_list') order by seqno")).map((c) => c.name)).toEqual(['organization_id', 'subscription_id', 'id'])
  })

  it('the pending-by-due query is served by the due index and the list query by the list index', async () => {
    const plan = async (q: string) => (await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q}`)).map((r) => r.detail).join(' | ')
    expect(await plan("SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= '2026-11-12T10:00:00.000Z' ORDER BY next_attempt_at, id LIMIT 50")).toMatch(/idx_webhook_deliveries_due/)
    expect(await plan(`SELECT id FROM webhook_deliveries WHERE organization_id = '${ORG}' AND subscription_id = '${id(1)}' AND id > '${id(0)}' ORDER BY id LIMIT 51`)).toMatch(/idx_webhook_deliveries_list/)
  })
})
