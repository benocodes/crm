import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createOwnerTestDb, createTestDb, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { StatementFailed, UnitDriftError, defineOperation, execute, readMaybe, selectColumns, step, unit, eq } from '@vault/storage'
import { classifyPostgresError, orgWriterKey, postgresBinding } from './index.js'

const db = createTestDb({ max: 4 })
const owner = createOwnerTestDb()
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
let org: { id: string }
let user: { id: string }
beforeAll(async () => {
  await truncateAll(owner)
  org = await seedOrganization(db)
  user = await seedUser(db, { organizationId: org.id, role: 'owner' })
})

const noop = (mutates: boolean) =>
  defineOperation<number>({ name: 'noop', mutates, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => 1 }) })

describe('the Postgres runtime', () => {
  const binding = postgresBinding(db)
  const identity = () => ({ actorId: user.id, organizationId: org.id })

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
})
