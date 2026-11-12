import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// API7 cycle 1 (D5, D12, D16, D20): migration 0016 applied over a database at 0015 that already holds data, and what the three tables refuse. The raw inserts are the permitted
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
const secret = (over: Record<string, unknown> = {}) => ({ id: id(21), created_at: AT, organization_id: ORG, created_by: USER, subscription_id: id(1), sealed: 'AAAA', key_version: 1, ...over })
const state = (over: Record<string, unknown> = {}) => ({ subscription_id: id(1), created_at: AT, organization_id: ORG, created_by: USER, cursor_event_id: id(30), ...over })

describe('migration 0016_webhooks over a database at 0015 with data', () => {
  it('applies, keeps every existing row, and adds the three tables empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0016')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0015_event_sequence.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await seedAgent(d1, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: ['tasks:read'] })
    const snapshot = async () => ({ agents: await all('select * from agents'), principals: await all('select * from principals'), events: await all('select * from events') })
    const before = await snapshot()
    expect(await all("select name from sqlite_master where name like 'webhook_%'")).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig16-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0016'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0016_webhooks.sql'])
    expect(await snapshot()).toEqual(before)
    for (const t of ['webhook_subscriptions', 'webhook_secrets', 'webhook_dispatch_state']) expect(await all(`select count(*) as n from ${t}`), t).toEqual([{ n: 0 }])
  })

  it('webhook_subscriptions: status, url, event_types, ids and timestamps are checked', async () => {
    expect(await insert('webhook_subscriptions', sub({ status: 'deleted' }))).toMatch(/webhook_subscriptions_status/)
    expect(await insert('webhook_subscriptions', sub({ url: '' }))).toMatch(/webhook_subscriptions_url/)
    expect(await insert('webhook_subscriptions', sub({ url: 'https://e.com/' + 'a'.repeat(2040) }))).toMatch(/webhook_subscriptions_url/)
    expect(await insert('webhook_subscriptions', sub({ event_types: 'nope' }))).toMatch(/webhook_subscriptions_event_types/)
    expect(await insert('webhook_subscriptions', sub({ event_types: '{}' }))).toMatch(/webhook_subscriptions_event_types/)
    expect(await insert('webhook_subscriptions', sub({ event_types: '[]' }))).toMatch(/webhook_subscriptions_event_types/)
    expect(await insert('webhook_subscriptions', sub({ event_types: JSON.stringify(Array.from({ length: 21 }, (_, i) => `task.t${i}`)) }))).toMatch(/webhook_subscriptions_event_types/)
    expect(await insert('webhook_subscriptions', sub({ id: 'x' }))).toMatch(/CHECK/)
    expect(await insert('webhook_subscriptions', sub({ created_at: 'soon' }))).toMatch(/CHECK/)
    expect(await insert('webhook_subscriptions', sub({ deleted_at: 'later' }))).toMatch(/CHECK/)
    expect(await insert('webhook_subscriptions', sub({ event_types: JSON.stringify(Array.from({ length: 20 }, (_, i) => `task.t${i}`)), status: 'disabled', deleted_at: AT }))).toBeNull()
    expect(await run('DELETE FROM webhook_subscriptions')).toBeNull()
    for (const status of ['active', 'paused', 'disabled']) {
      expect(await insert('webhook_subscriptions', sub({ id: id(40 + ['active', 'paused', 'disabled'].indexOf(status)), status })), status).toBeNull()
    }
    expect(await run('DELETE FROM webhook_subscriptions')).toBeNull()
  })

  it('the foreign keys refuse a missing agent, creator, organisation or subscription; the agent key is composite (organisation, id)', async () => {
    expect(await insert('webhook_subscriptions', sub({ agent_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_subscriptions', sub({ created_by: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_subscriptions', sub({ organization_id: id(98) }))).toMatch(/FOREIGN KEY/)
    // a user is not an agent
    expect(await insert('webhook_subscriptions', sub({ agent_id: USER }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_subscriptions', sub())).toBeNull()
    expect(await insert('webhook_secrets', secret({ subscription_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('webhook_dispatch_state', state({ subscription_id: id(98) }))).toMatch(/FOREIGN KEY/)
    const fks = await all<{ table: string; from: string }>("select \"table\", \"from\" from pragma_foreign_key_list('webhook_subscriptions') where \"table\" = 'agents'")
    expect(fks.map((f) => f.from).sort()).toEqual(['agent_id', 'organization_id'])
  })

  it('has the live-subscriptions index of the plan, partial on deleted_at', async () => {
    const idx = await all<{ name: string; partial: number }>("select name, partial from pragma_index_list('webhook_subscriptions') where name like 'idx_%'")
    expect(idx).toEqual([{ name: 'idx_webhook_subscriptions_agent', partial: 1 }])
  })

  it('webhook_secrets: sealed and key_version are checked; rows append, and an UPDATE aborts (append_only), as does any column', async () => {
    expect(await insert('webhook_secrets', secret({ sealed: '' }))).toMatch(/CHECK/)
    expect(await insert('webhook_secrets', secret({ key_version: 0 }))).toMatch(/CHECK/)
    expect(await insert('webhook_secrets', secret())).toBeNull()
    expect(await insert('webhook_secrets', secret({ id: id(22), created_at: '2026-11-12T10:00:00.000Z', key_version: 2 }))).toBeNull()
    expect(await run("UPDATE webhook_secrets SET sealed = 'BBBB' WHERE id = ?", id(21))).toMatch(/append_only/)
    expect(await run('UPDATE webhook_secrets SET key_version = 5')).toMatch(/append_only/)
    expect((await all('select sealed, key_version from webhook_secrets order by id')).map((r: any) => [r.sealed, r.key_version])).toEqual([['AAAA', 1], ['AAAA', 2]])
  })

  it('webhook_dispatch_state: one row per subscription, an event id as the cursor (no foreign key to events), optional stamps', async () => {
    expect(await insert('webhook_dispatch_state', state({ cursor_event_id: 'x' }))).toMatch(/CHECK/)
    expect(await insert('webhook_dispatch_state', state({ cursor_event_id: null }))).toMatch(/NOT NULL/)
    expect(await insert('webhook_dispatch_state', state({ last_dispatched_at: 'soon' }))).toMatch(/CHECK/)
    expect(await insert('webhook_dispatch_state', state())).toBeNull()
    expect(await insert('webhook_dispatch_state', state({ cursor_event_id: id(31) }))).toMatch(/UNIQUE|PRIMARY/)
    expect(await run('UPDATE webhook_dispatch_state SET cursor_event_id = ?, last_dispatched_at = ?, last_success_at = ?', id(31), AT, AT)).toBeNull()
    expect((await all('select cursor_event_id from webhook_dispatch_state'))[0]).toEqual({ cursor_event_id: id(31) })
  })
})
