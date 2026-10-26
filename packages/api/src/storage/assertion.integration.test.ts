import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, assertStep, defineOperation, exactly, step, unit, uuidv7, type PreparedOperation, type QueryContext, type Step } from '@vault/storage'
import { mapStorageError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { openEngines, type Engine } from '../test/engines.js'

// CORE36 D4: the assertion step and exactly(n) on both engines. A failed assertion aborts the whole unit.
const AT = '2026-10-22T10:00:00.000Z'
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('unit assertions on %s', (name) => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })

  const unitWith = (finish: (qc: QueryContext, id: string) => Step[]): PreparedOperation<null> => {
    const id = uuidv7()
    const eventId = uuidv7()
    return defineOperation<null>({
      name: 'assertion.demo',
      mutates: true,
      reads: () => ({}),
      build: (_f, qc) =>
        unit({
          steps: [
            step(
              qc.db.insertInto('tasks').values({ id, organization_id: e.organizationId, title: 't', status: 'open', created_by: e.userId, created_at: AT, updated_at: AT }),
              'first-mutation',
            ),
            step(
              eventStatement(qc, { id: eventId, at: AT, organizationId: e.organizationId, actorId: e.userId, type: 'task.created', resourceType: 'task', resourceId: id, before: null, after: { table: 'tasks', columns: ['id', 'title'] } }),
              'first-event',
            ),
            ...finish(qc, id),
          ],
          events: [],
          decode: () => null,
        }),
    })
  }

  it('a false assertion aborts the unit as drift: no task, no event (mapped to 409 conflict)', async () => {
    const err = await settle(e.run(unitWith((qc) => [assertStep(qc, sql<SqlBool>`1 = 0`)])))
    expect(err).toBeInstanceOf(UnitDriftError)
    expect(mapStorageError(err)).toMatchObject({ status: 409, code: 'conflict' })
    expect(await e.tasks()).toHaveLength(0)
    expect(await e.events()).toHaveLength(0)
  })

  it('a true assertion lets the task and the event commit', async () => {
    await e.run(unitWith((qc) => [assertStep(qc, sql<SqlBool>`1 = 1`)]))
    expect(await e.tasks()).toHaveLength(1)
    expect(await e.events()).toHaveLength(1)
  })

  it('exactly(n) with the wrong n aborts the unit', async () => {
    const err = await settle(
      e.run(unitWith((qc, id) => exactly(qc, step(qc.db.updateTable('tasks').set({ title: 'x' }).where('tasks.id', '=', id)), 2))),
    )
    expect(err).toBeInstanceOf(UnitDriftError)
    expect(await e.tasks()).toHaveLength(0)
    expect(await e.events()).toHaveLength(0)
  })

  it('exactly(n) with the right n commits', async () => {
    await e.run(unitWith((qc, id) => exactly(qc, step(qc.db.updateTable('tasks').set({ title: 'x' }).where('tasks.id', '=', id)), 1)))
    expect((await e.tasks())[0]!.title).toBe('x')
  })
})
