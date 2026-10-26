import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { codecs, uuidv7 } from '@vault/storage'
import { ApiError } from '../errors.js'
import { taskCompletion, tasks } from '../resources/tasks.js'
import { createOperation, deleteOperation, getOperation, listOperation, updateOperation } from './crud.js'
import { openEngines, type Engine } from '../test/engines.js'

const NOW = new Date('2026-10-22T10:00:00.000Z')
const EARLIER = '2026-10-22T08:30:00.000Z'
const refuse = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ApiError | null

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('tasks through the prepared executor on %s', (name) => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })

  it('creates a task whose response, row and event `after` are the same record', async () => {
    const { value, events, stats } = await e.run(createOperation(tasks, e.env({ now: NOW }), { title: 'A', status: 'done', assignee_id: e.user2Id }))
    expect(value).toMatchObject({ title: 'A', status: 'done', completed_at: NOW.toISOString(), created_at: NOW.toISOString(), updated_at: NOW.toISOString(), assignee_id: e.user2Id, created_by: e.userId })
    const [row] = await e.tasks()
    expect(row!.id).toBe(value.id)
    const [event] = await e.events()
    expect(event).toMatchObject({ type: 'task.created', resource_id: value.id, actor_id: e.userId, organization_id: e.organizationId, before: null })
    expect(event!.after).toEqual(value)
    expect(events).toHaveLength(1)
    // Statement count: reference check, then write + event + result (+ the writer lock on Postgres).
    expect(stats).toMatchObject({ reads: 1, writes: 3, locks: name === 'postgres' ? 1 : 0 })
  })

  describe('completion: the SQL CASE equals taskCompletion over every input', () => {
    const cases = [
      ...(['open', 'done'] as const).flatMap((before) => ([{ status: 'done' }, { status: 'open' }, { title: 'only a title' }] as const).map((input) => [before, input] as const)),
    ]
    it.each(cases)('stored %s, patch %j', async (before, input) => {
      const id = uuidv7()
      await e.insertTask({ id, title: 't', status: before, completed_at: before === 'done' ? EARLIER : null })
      const { value } = await e.run(updateOperation(tasks, e.env({ now: NOW }), id, input))
      const change = taskCompletion(input, { status: before }, NOW)
      const expected = 'completed_at' in change ? (change.completed_at ? codecs.timestamp.write(change.completed_at) : null) : before === 'done' ? EARLIER : null
      expect(value.completed_at).toBe(expected)
      const [row] = await e.tasks()
      expect(codecs.timestamp.readNullable(row!.completed_at)).toBe(expected)
    })
  })

  it('an empty patch checks existence, changes nothing and emits no event', async () => {
    const id = uuidv7()
    await e.insertTask({ id, title: 't', at: EARLIER })
    const { value, stats, events } = await e.run(updateOperation(tasks, e.env({ now: NOW }), id, {}))
    expect(value).toMatchObject({ id, title: 't', updated_at: EARLIER })
    expect(await e.events()).toHaveLength(0)
    expect(events).toEqual([])
    expect(stats.writes).toBe(0)
    expect((await refuse(e.run(updateOperation(tasks, e.env(), uuidv7(), {}))))).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('a same-value patch is a real update, as before (event with equal before/after fields, new updated_at)', async () => {
    const id = uuidv7()
    await e.insertTask({ id, title: 'same', at: EARLIER })
    const { value } = await e.run(updateOperation(tasks, e.env({ now: NOW }), id, { title: 'same' }))
    const [event] = await e.events()
    const [row] = await e.tasks()
    // Both engines: the response, the event's `after` and the stored row agree; `before` is the prior record.
    expect(event!.before).toMatchObject({ title: 'same', updated_at: EARLIER })
    expect(event!.after).toMatchObject({ title: 'same', updated_at: value.updated_at })
    expect(codecs.timestamp.read(row!.updated_at)).toBe(value.updated_at)
    // The application owns the clock on both engines (CORE36 D2): updated_at is exactly the unit's injected time.
    expect(value.updated_at).toBe(NOW.toISOString())
  })

  it('event `before` is the exact prior record and `after` the stored one', async () => {
    const created = (await e.run(createOperation(tasks, e.env({ now: new Date(EARLIER) }), { title: 'x' }))).value
    const updated = (await e.run(updateOperation(tasks, e.env({ now: NOW }), created.id, { status: 'done', notes: 'n' }))).value
    const events = await e.events()
    expect(events[1]!.before).toEqual(created)
    expect(events[1]!.after).toEqual(updated)
    expect(updated.completed_at).toBe(NOW.toISOString())
  })

  it('refuses a missing assignee with invalid_reference and no partial effect', async () => {
    const err = await refuse(e.run(createOperation(tasks, e.env(), { title: 'x', assignee_id: uuidv7() })))
    expect(err).toMatchObject({ status: 400, code: 'invalid_reference', message: 'a referenced record does not exist' })
    expect(await e.tasks()).toHaveLength(0)
    expect(await e.events()).toHaveLength(0)
    const id = uuidv7()
    await e.insertTask({ id, title: 't' })
    expect(await refuse(e.run(updateOperation(tasks, e.env(), id, { title: 'changed', assignee_id: uuidv7() })))).toMatchObject({ code: 'invalid_reference' })
    expect((await e.tasks())[0]!.title).toBe('t')
    expect(await e.events()).toHaveLength(0)
    // Existence is checked first: a missing task is 404 even with a bad assignee.
    expect(await refuse(e.run(updateOperation(tasks, e.env(), uuidv7(), { assignee_id: uuidv7() })))).toMatchObject({ status: 404 })
  })

  it('deletes softly, hides the row everywhere and records the last record', async () => {
    const id = uuidv7()
    await e.insertTask({ id, title: 'bye', at: EARLIER })
    await e.run(deleteOperation(tasks, e.env({ now: NOW, as: 'agent' }), id), 'agent')
    expect((await e.tasks())[0]!.deleted_at).not.toBeNull()
    const [event] = await e.events()
    expect(event).toMatchObject({ type: 'task.deleted', actor_id: e.agentId, after: null })
    expect(event!.before).toMatchObject({ id, title: 'bye' })
    expect(await refuse(e.run(getOperation(tasks, e.env(), id)))).toMatchObject({ status: 404 })
    expect(await refuse(e.run(deleteOperation(tasks, e.env(), id)))).toMatchObject({ status: 404 })
    expect((await e.run(listOperation(tasks, e.env(), {}))).value.data).toEqual([])
  })

  it('statement counts per operation (recorded in RESULT.md)', async () => {
    const created = await e.run(createOperation(tasks, e.env({ now: NOW }), { title: 'c' }))
    const updated = await e.run(updateOperation(tasks, e.env({ now: NOW }), created.value.id, { title: 'u' }))
    const read = await e.run(getOperation(tasks, e.env(), created.value.id))
    const deleted = await e.run(deleteOperation(tasks, e.env({ now: NOW }), created.value.id))
    const lock = name === 'postgres' ? 1 : 0
    expect(created.stats).toMatchObject({ reads: 0, writes: 3, locks: lock, statements: 3 + lock })
    expect(updated.stats).toMatchObject({ reads: 1, writes: 3, locks: lock, statements: 4 + lock })
    expect(read.stats).toMatchObject({ reads: 1, writes: 0, locks: 0, statements: 1 })
    expect(deleted.stats).toMatchObject({ reads: 1, writes: 3, locks: lock, statements: 4 + lock })
  })
})
