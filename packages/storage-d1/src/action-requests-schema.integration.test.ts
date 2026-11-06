import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// AGT8 cycle 1 (D3, D4, D5, D20, D23, D27): migration 0011 applied over a database at 0010 that already holds data, and what the table refuses.
// The raw inserts are the permitted exception: the schema test proves what the database refuses, which no operation reaches.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-06T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const CONTACT = id(10)

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
const base = { organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT }
const req = (over: Record<string, unknown> = {}) => ({
  id: id(1), ...base, operation: 'tasks.update', arguments: '{"id":"x"}', status: 'pending', reason: 'r', evidence: '[]', expires_at: '2026-11-13T09:00:00.000Z', ...over,
})
const decided = { decided_by: AGENT, decided_at: AT }

describe('migration 0011_action_requests over a database at 0010 with data', () => {
  it('applies, keeps every existing row, and adds the one table empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0011')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0010_gmail_capture.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await seedPrincipal(d1, { id: AGENT, kind: 'agent' })
    expect(await insert('contacts', { id: CONTACT, ...base, name: 'Ann' })).toBeNull()
    expect(await insert('tasks', { id: id(11), ...base, title: 'T', status: 'open' })).toBeNull()
    expect(await insert('events', { id: id(12), created_at: AT, organization_id: ORG, type: 'task.created', resource_type: 'task', resource_id: id(11), actor_id: USER })).toBeNull()
    const snapshot = async () => ({ contacts: await all('select * from contacts'), tasks: await all('select * from tasks'), events: await all('select * from events'), principals: await all('select * from principals') })
    const before = await snapshot()
    expect(await all("select name from sqlite_master where name = 'action_requests'")).toEqual([])
    const only = mkdtempSync(join(tmpdir(), 'mig11-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0011'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0011_action_requests.sql'])
    expect(await snapshot()).toEqual(before)
    expect(await all('select count(*) as n from action_requests')).toEqual([{ n: 0 }])
  })

  it('the status CHECK admits the eight statuses and refuses any other', async () => {
    expect(await insert('action_requests', req({ id: id(20), status: 'paused' }))).toMatch(/action_requests_status/)
    for (const [i, status] of (['rejected', 'withdrawn', 'expired', 'superseded', 'approved', 'failed'] as const).entries()) {
      expect(await insert('action_requests', req({ id: id(21 + i), status, ...decided })), status).toBeNull()
    }
    expect(await insert('action_requests', req({ id: id(30), status: 'executed', ...decided, executed_at: AT }))).toBeNull()
  })

  it('only pending has no decision, and only executed has executed_at', async () => {
    expect(await insert('action_requests', req({ id: id(31), status: 'rejected' }))).toMatch(/action_requests_decided/)
    expect(await insert('action_requests', req({ id: id(31), status: 'pending', ...decided }))).toMatch(/action_requests_decided/)
    expect(await insert('action_requests', req({ id: id(31), status: 'pending', decided_by: AGENT }))).toMatch(/action_requests_decided/)
    expect(await insert('action_requests', req({ id: id(31), status: 'executed', ...decided }))).toMatch(/action_requests_executed/)
    expect(await insert('action_requests', req({ id: id(31), status: 'rejected', ...decided, executed_at: AT }))).toMatch(/action_requests_executed/)
  })

  it('the partial unique index admits one pending request per (organisation, dedup_key); a decided one frees the key; null keys never collide', async () => {
    expect(await insert('action_requests', req({ id: id(40), dedup_key: 'k' }))).toBeNull()
    expect(await insert('action_requests', req({ id: id(41), dedup_key: 'k' }))).toMatch(/UNIQUE/)
    expect(await insert('action_requests', req({ id: id(41), dedup_key: 'other' }))).toBeNull()
    expect(await run("UPDATE action_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", AGENT, AT, id(40))).toBeNull()
    expect(await insert('action_requests', req({ id: id(42), dedup_key: 'k' }))).toBeNull()
    expect(await insert('action_requests', req({ id: id(43) }))).toBeNull()
    expect(await insert('action_requests', req({ id: id(44) }))).toBeNull()
  })

  it('JSON columns, text bounds and ids are checked', async () => {
    expect(await insert('action_requests', req({ id: id(50), arguments: 'nope' }))).toMatch(/action_requests_arguments/)
    expect(await insert('action_requests', req({ id: id(50), arguments: '[1]' }))).toMatch(/action_requests_arguments/)
    expect(await insert('action_requests', req({ id: id(50), edited_arguments: '[1]' }))).toMatch(/action_requests_edited_arguments/)
    expect(await insert('action_requests', req({ id: id(50), evidence: '{}' }))).toMatch(/action_requests_evidence/)
    expect(await insert('action_requests', req({ id: id(50), evidence: JSON.stringify(Array.from({ length: 21 }, () => ({}))) }))).toMatch(/action_requests_evidence/)
    expect(await insert('action_requests', req({ id: id(50), reason: '' }))).toMatch(/action_requests_reason/)
    expect(await insert('action_requests', req({ id: id(50), reason: 'x'.repeat(2001) }))).toMatch(/action_requests_reason/)
    expect(await insert('action_requests', req({ id: id(50), dedup_key: '' }))).toMatch(/action_requests_dedup_key/)
    expect(await insert('action_requests', req({ id: id(50), result: 'nope' }))).toMatch(/action_requests_result/)
    expect(await insert('action_requests', req({ id: 'x' }))).toMatch(/CHECK/)
    expect(await insert('action_requests', req({ id: id(50), expires_at: 'tomorrow' }))).toMatch(/CHECK/)
  })

  it('the foreign keys refuse a missing principal, contact, thread, interaction or superseding request', async () => {
    expect(await insert('action_requests', req({ id: id(60), created_by: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_requests', req({ id: id(60), status: 'rejected', decided_by: id(98), decided_at: AT }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_requests', req({ id: id(60), contact_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_requests', req({ id: id(60), thread_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_requests', req({ id: id(60), interaction_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_requests', req({ id: id(60), status: 'superseded', ...decided, superseded_by_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_requests', req({ id: id(60), contact_id: CONTACT }))).toBeNull()
    expect(await insert('action_requests', req({ id: id(61), status: 'superseded', ...decided, superseded_by_id: id(60) }))).toBeNull()
  })

  it('has the lookup indexes of the plan', async () => {
    const idx = (await all<{ name: string; unique: number; partial: number }>("select name, \"unique\", partial from pragma_index_list('action_requests') where name like 'idx_%'")).map((r) => `${r.name}:${r.unique}:${r.partial}`).sort()
    expect(idx).toEqual([
      'idx_action_requests_contact:0:1',
      'idx_action_requests_interaction:0:1',
      'idx_action_requests_organization_created_by:0:0',
      'idx_action_requests_organization_operation:0:0',
      'idx_action_requests_organization_status:0:0',
      'idx_action_requests_pending_dedup:1:1',
      'idx_action_requests_pending_expiry:0:1',
      'idx_action_requests_thread:0:1',
    ])
  })
})
