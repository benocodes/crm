import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { applyMigrations, clearD1, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// API105 (D1, D15, D16): `events.seq` is the commit order, `events` is append-only, and migration 0015 rebuilds the table over existing rows.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1', 'OLD'], { migrate: false })
  d1 = local.bindings.D1!
  await applyMigrations(d1)
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
})
afterAll(async () => {
  await local.dispose()
})

const all = async (db: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await db
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Record<string, any>[]
const run = (db: D1Like, text: string, ...binds: unknown[]) =>
  db
    .prepare(text)
    .bind(...binds)
    .run()
const insertEvent = (
  db: D1Like,
  n: number,
  over: { type?: string; before?: string | null; after?: string | null } = {},
) =>
  run(
    db,
    'INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id(n),
    AT,
    ORG,
    over.type ?? 'task.created',
    'task',
    id(900 + n),
    USER,
    over.before ?? null,
    over.after ?? null,
  )

describe('the rebuilt events table', () => {
  it('has seq as an AUTOINCREMENT integer primary key and id as a unique, UUID-checked text column', async () => {
    const [row] = await all(d1, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    expect(row?.sql).toMatch(/seq INTEGER PRIMARY KEY AUTOINCREMENT/i)
    expect(row?.sql).toMatch(/id TEXT NOT NULL UNIQUE/i)
    expect(row?.sql).toMatch(/ON DELETE CASCADE/i)
    await expect(
      run(
        d1,
        'INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'not-a-uuid',
        AT,
        ORG,
        't',
        'task',
        id(1),
        USER,
      ),
    ).rejects.toThrow(/CHECK|constraint/i)
  })

  it('has the (resource_id, seq) index and not the old id index', async () => {
    const indexes = (await all(d1, "SELECT name FROM pragma_index_list('events')")).map((r) => r.name)
    expect(indexes).not.toContain('idx_events_organization_id_id')
    const name = indexes.find((n) => n === 'idx_events_resource_id_seq')
    expect(name).toBeDefined()
    expect(
      (await all(d1, "SELECT name FROM pragma_index_info('idx_events_resource_id_seq') ORDER BY seqno")).map(
        (r) => r.name,
      ),
    ).toEqual(['resource_id', 'seq'])
  })

  it('assigns seq in insertion order whatever the ids', async () => {
    await clearD1(d1)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    for (const n of [30, 10, 20]) await insertEvent(d1, n)
    expect((await all(d1, 'SELECT id FROM events ORDER BY seq')).map((r) => r.id)).toEqual([30, 10, 20].map(id))
  })
})

describe('events is append-only (D15)', () => {
  beforeAll(async () => {
    await clearD1(d1)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
  })

  it('aborts an UPDATE with append_only and changes nothing', async () => {
    await insertEvent(d1, 50)
    await expect(run(d1, "UPDATE events SET type = 'x' WHERE id = ?", id(50))).rejects.toThrow(/append_only/)
    expect((await all(d1, 'SELECT type FROM events WHERE id = ?', id(50))).map((r) => r.type)).toEqual(['task.created'])
  })

  it('still allows DELETE (the harness clears the table) and the organisation cascade', async () => {
    await insertEvent(d1, 51)
    await run(d1, 'DELETE FROM events WHERE id = ?', id(51))
    expect(await all(d1, 'SELECT id FROM events WHERE id = ?', id(51))).toEqual([])
    await insertEvent(d1, 52)
    await clearD1(d1)
    expect(await all(d1, 'SELECT id FROM events')).toEqual([])
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await insertEvent(d1, 53)
    await run(d1, 'DELETE FROM organizations WHERE id = ?', ORG)
    expect(await all(d1, 'SELECT id FROM events')).toEqual([])
  })
})
