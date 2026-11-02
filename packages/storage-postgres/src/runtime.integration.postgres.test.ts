import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createOwnerTestDb, createTestDb, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { StatementFailed, StorageError, UnitDriftError, defineOperation, execute, readAll, readMaybe, selectColumns, step, unit, eq } from '@vault/storage'
import { classifyPostgresError, orgWriterKey, postgresBinding } from './index.js'

const db = createTestDb({ max: 4 })
const owner = createOwnerTestDb()
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
let org: { id: string }
let user: { id: string }
beforeEach(async () => {
  await truncateAll(owner)
  org = await seedOrganization(db)
  user = await seedUser(db, { organizationId: org.id, role: 'owner' })
})

const noop = (mutates: boolean) =>
  defineOperation<number>({ name: 'noop', mutates, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => 1 }) })

describe('the Postgres runtime', () => {
  const binding = postgresBinding(db)
  const identity = () => ({ kind: 'tenant' as const, actorId: user.id, organizationId: org.id })

  it('takes the organisation writer lock for a mutating unit only, and counts the statements it sends', async () => {
    const write = await execute(binding, identity(), noop(true))
    const read = await execute(binding, identity(), noop(false))
    expect(write.stats).toMatchObject({ locks: 1, statements: 1, roundTrips: 1 })
    expect(read.stats).toMatchObject({ locks: 0, statements: 0 })
  })

  it('holds the writer lock until the unit ends: a second unit waits (observed through pg_locks)', async () => {
    const key = orgWriterKey(org.id)
    const holder = defineOperation<number>({
      name: 'hold',
      mutates: true,
      reads: () => ({}),
      build: () =>
        unit({
          steps: [step(sql`select pg_sleep(0.3)`.compile(db))],
          events: [],
          decode: () => 1,
        }),
    })
    const first = execute(binding, identity(), holder)
    await new Promise((r) => setTimeout(r, 100))
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid <> pg_backend_pid()`.execute(owner)
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1)
    const t0 = Date.now()
    await execute(binding, identity(), noop(true))
    expect(Date.now() - t0).toBeGreaterThan(80) // it queued behind the holder
    await first
    expect(key).toBe(`org-writer:${org.id}`)
  })

  it('aborts a unit whose guarded write affected nothing (drift) and rolls back', async () => {
    const op = defineOperation<number>({
      name: 'drift',
      mutates: true,
      reads: (qc) => ({ t: readMaybe(selectColumns(qc, 'tasks', ['id']).where(eq('tasks', 'id', '0190b2c4-0000-7000-8000-00000000dead'))) }),
      build: (_f, qc) =>
        unit({
          steps: [step(qc.db.updateTable('tasks').set({ title: 'x' }).where(eq('tasks', 'id', '0190b2c4-0000-7000-8000-00000000dead')), 'first-mutation', { expect: 'affected' })],
          events: [],
          decode: () => 1,
        }),
    })
    await expect(execute(binding, identity(), op)).rejects.toBeInstanceOf(UnitDriftError)
  })

  it('classifies database errors the same way D1 does', async () => {
    expect(classifyPostgresError({ code: '23503' })).toBe('foreign_key')
    expect(classifyPostgresError({ code: '23505' })).toBe('unique')
    expect(classifyPostgresError({ code: '23514' })).toBe('check')
    expect(classifyPostgresError({ code: '23502' })).toBe('not_null')
    expect(classifyPostgresError({ code: '42501' })).toBe('other')
    expect(classifyPostgresError(new Error('boom'))).toBeNull()
    const bad = defineOperation<number>({
      name: 'bad',
      mutates: true,
      reads: () => ({}),
      build: () => unit({ steps: [step(sql`insert into tasks (id) values (null)`.compile(db))], events: [], decode: () => 1 }),
    })
    await expect(execute(binding, identity(), bad)).rejects.toBeInstanceOf(StatementFailed)
  })

  describe('exact counts and holds-assertions (CORE36 C2)', () => {
    const insertTask = (qc: { db: any }, id: string) =>
      sql`insert into tasks (id, organization_id, title, created_by, created_at, updated_at) values (${id}, ${org.id}, 't', ${user.id}, '2026-10-22T08:00:00.000Z', '2026-10-22T08:00:00.000Z')`.compile(qc.db)
    const A = '0190b2c4-0000-7000-8000-0000000000a1'
    const count = async () => Number((await sql<{ n: string }>`select count(*)::int as n from tasks`.execute(owner)).rows[0]!.n)

    it('aborts and rolls back a unit whose statement affected fewer rows than { rows: n }', async () => {
      const op = defineOperation<number>({
        name: 'exactly',
        mutates: true,
        reads: () => ({}),
        build: (_f, qc) =>
          unit({
            steps: [
              step(insertTask(qc, A), 'first-mutation'),
              step(qc.db.updateTable('tasks').set({ title: 'x' }).where(eq('tasks', 'id', A)), undefined, { expect: { rows: 2 } }),
            ],
            events: [],
            decode: () => 1,
          }),
      })
      await expect(execute(binding, identity(), op)).rejects.toBeInstanceOf(UnitDriftError)
      expect(await count()).toBe(0)
    })

    it('accepts a statement that affected exactly { rows: n }', async () => {
      const op = defineOperation<number>({
        name: 'exactly.ok',
        mutates: true,
        reads: () => ({}),
        build: (_f, qc) => unit({ steps: [step(insertTask(qc, A), 'first-mutation', { expect: { rows: 1 } })], events: [], decode: () => 1 }),
      })
      await execute(binding, identity(), op)
      expect(await count()).toBe(1)
    })

    it.each([
      ['false', false],
      ['true', true],
    ])('expect "holds" on select %s', async (_n, holds) => {
      const op = defineOperation<number>({
        name: 'holds',
        mutates: true,
        reads: () => ({}),
        build: (_f, qc) =>
          unit({
            steps: [step(insertTask(qc, A), 'first-mutation'), step(sql`select cast(${holds} as boolean) as holds`.compile(qc.db), undefined, { expect: 'holds' })],
            events: [],
            decode: () => 1,
          }),
      })
      if (holds) {
        await execute(binding, identity(), op)
        expect(await count()).toBe(1)
      } else {
        await expect(execute(binding, identity(), op)).rejects.toBeInstanceOf(UnitDriftError)
        expect(await count()).toBe(0)
      }
    })
  })
})

/** A pool whose executed queries are counted: a refusal "before any SQL" must leave the count at zero. */
function spyPool(): { pool: Kysely<Database>; queries: () => number } {
  let n = 0
  const pool = db.withPlugin({ transformQuery: (a) => a.node, transformResult: async (a) => (n++, a.result) })
  return { pool, queries: () => n }
}

describe('storage identities (CORE41 C1)', () => {
  const binding = postgresBinding(db)
  const probe = (mutates: boolean) =>
    defineOperation<string>({
      name: 'who',
      mutates,
      reads: (qc) => ({ who: readMaybe(qc.db.selectNoFrom(sql<string>`current_user`.as('who'))) }),
      build: (found) => unit({ steps: [], events: [], decode: () => found.one('who').who as string }),
    })
  const listMemberships = defineOperation<string[]>({
    name: 'memberships.all',
    mutates: false,
    reads: (qc) => ({ rows: readAll(selectColumns(qc, 'memberships', ['id', 'organization_id']).orderBy('memberships.id')) }),
    build: (found) => unit({ steps: [], events: [], decode: () => found.all('rows').map((r) => r.organization_id as string) }),
  })

  it('internal runs as the service role', async () => {
    const res = await execute(binding, { kind: 'internal', organizationId: null }, probe(false))
    expect(res.value).toBe('vault_service')
  })

  it('internal with an organisation takes the writer lock when it mutates', async () => {
    const res = await execute(binding, { kind: 'internal', organizationId: org.id }, noop(true))
    expect(res.stats.locks).toBe(1)
  })

  it('internal with an organisation does not lock a read-only unit', async () => {
    expect((await execute(binding, { kind: 'internal', organizationId: org.id }, noop(false))).stats.locks).toBe(0)
  })

  it('internal without an organisation does not lock, even when it mutates', async () => {
    expect((await execute(binding, { kind: 'internal', organizationId: null }, noop(true))).stats.locks).toBe(0)
  })

  it('internal rejects a non-UUID organisation before sending any statement', async () => {
    const spy = spyPool()
    const err = await execute(postgresBinding(spy.pool), { kind: 'internal', organizationId: 'x' }, noop(true)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StorageError)
    expect(spy.queries()).toBe(0)
  })

  it('account reads across organisations', async () => {
    const other = await seedOrganization(db, { name: 'Other' })
    await seedUser(db, { organizationId: other.id })
    const res = await execute(binding, { kind: 'account', actorId: user.id }, listMemberships)
    expect(new Set(res.value)).toEqual(new Set([org.id, other.id]))
    expect(res.stats.locks).toBe(0)
  })

  it('account refuses a mutating unit before any SQL', async () => {
    const spy = spyPool()
    const err = await execute(postgresBinding(spy.pool), { kind: 'account', actorId: user.id }, noop(true)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StorageError)
    expect((err as Error).message).toMatch(/account units are read-only/)
    expect(spy.queries()).toBe(0)
  })

  it('tenant still sees only its own organisation (RLS)', async () => {
    const other = await seedOrganization(db, { name: 'Other' })
    await seedUser(db, { organizationId: other.id })
    const res = await execute(binding, { kind: 'tenant', actorId: user.id, organizationId: org.id }, listMemberships)
    expect(res.value).toEqual([org.id])
  })
})
