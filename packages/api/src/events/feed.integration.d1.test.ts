import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { defineOperation, step, unit, uuidv7, type PreparedOperation } from '@vault/storage'
import { eventSetStatement } from '../outbox.js'
import { afterOf } from '../storage/crud.js'
import { tasks } from '../resources/tasks.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { captureMessage, runCapture } from "../test/capture-kit.js"
import { readStableFeed, type FeedEvent } from './feed.js'

// API105 (D1, D13, D15, D22): `seq` is the commit order, and readStableFeed pages after a cursor without skipping an event that
// committed out of id order. The program is internal; nothing registered calls it yet.
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
})

const AT = '2026-10-28T10:00:00.000Z'
const TYPES = ['task', 'contact', 'note']
const feed = async (d: { readable?: readonly string[]; types?: readonly string[]; after?: string | null; limit?: number }) =>
  (await e.run(readStableFeed({ readable: TYPES, after: null, limit: 50, ...d }))).value
const page = async (d: Parameters<typeof feed>[0]): Promise<{ events: FeedEvent[]; has_more: boolean }> => {
  const r = await feed(d)
  if (r.status !== 'ok') throw new Error('unknown cursor')
  return r
}
const ids = (events: readonly { id: string }[]) => events.map((x) => x.id)

/** One unit that emits one `task.created` event with the given id for an existing task, through the set statement. */
function emit(eventId: string, taskId: string, type = 'task.created'): PreparedOperation<null> {
  return defineOperation<null>({
    name: 'test.emit',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [step(eventSetStatement(qc, { at: AT, organizationId: e.organizationId, actorId: e.userId, type, resourceType: 'task', after: afterOf(tasks), rows: [{ eventId, resourceId: taskId, before: null }] }), 'first-event')],
        events: [{ id: eventId, type, resourceType: 'task', resourceId: taskId }],
        decode: () => null,
      }),
  })
}
const newTask = async () => {
  const id = uuidv7()
  await e.insertTask({ id, title: 't' })
  return id
}
/** A raw event row (setup only), for the read program's filters. */
const rawEvent = (id: string, type: string, resourceType: string) =>
  e.d1!
    .prepare('INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, AT, e.organizationId, type, resourceType, uuidv7(), e.userId)
    .run()

describe('commit order across units (D1, D22)', () => {
  it('a reader whose cursor is B receives A, committed after B, on its next page; paging from the start returns B then A', async () => {
    const A = uuidv7(new Date('2026-10-28T10:00:00.000Z'))
    const B = uuidv7(new Date('2026-10-28T10:00:00.001Z'))
    expect(A < B).toBe(true)
    const t = await newTask()
    await e.run(emit(B, t))
    expect(ids((await page({ after: null })).events)).toEqual([B])
    const cursorB = await page({ after: B })
    expect(cursorB.events).toEqual([])
    await e.run(emit(A, t, 'task.updated'))
    expect(ids((await page({ after: B })).events)).toEqual([A])
    expect(ids((await page({ after: null })).events)).toEqual([B, A])
  })
})

describe('emit order and atomicity within a unit', () => {
  it('an event set reads back in the order of its rows', async () => {
    const t = [await newTask(), await newTask(), await newTask()]
    const evIds = [uuidv7(), uuidv7(), uuidv7()].reverse() // ids descending: id order is not emit order
    const op = defineOperation<null>({
      name: 'test.emit_set',
      mutates: true,
      reads: () => ({}),
      build: (_f, qc) =>
        unit({
          steps: [step(eventSetStatement(qc, { at: AT, organizationId: e.organizationId, actorId: e.userId, type: 'task.updated', resourceType: 'task', after: afterOf(tasks), rows: t.map((id, i) => ({ eventId: evIds[i]!, resourceId: id, before: null })) }), 'first-event')],
          events: [],
          decode: () => null,
        }),
    })
    await e.run(op)
    expect(ids((await page({})).events)).toEqual(evIds)
  })

  it("capture's recordMessages events read back in emit order", async () => {
    await runCapture(e, { connection_id: uuidv7(), messages: [captureMessage(e.organizationId, { attachments: 1 })] })
    const types = (await page({ readable: ['thread', 'message', 'file', 'interaction'] })).events.map((x) => x.type)
    expect(types).toEqual(['thread.created', 'message.created', 'file.created', 'interaction.created'])
  })

  it('a unit that fails part-way leaves none of its events readable', async () => {
    const t = await newTask()
    const evId = uuidv7()
    const bad = defineOperation<null>({
      name: 'test.emit_then_fail',
      mutates: true,
      reads: () => ({}),
      build: (_f, qc) =>
        unit({
          steps: [
            step(eventSetStatement(qc, { at: AT, organizationId: e.organizationId, actorId: e.userId, type: 'task.created', resourceType: 'task', after: afterOf(tasks), rows: [{ eventId: evId, resourceId: t, before: null }] }), 'first-event'),
            step(sql`insert into tasks (id) values (${uuidv7()})`.compile(qc.db)), // NOT NULL violation after the event
          ],
          events: [],
          decode: () => null,
        }),
    })
    await expect(e.run(bad)).rejects.toThrow()
    expect((await page({})).events).toEqual([])
    expect(await e.rows('events')).toEqual([])
  })
})

describe('the read program (D2 resolution, D22)', () => {
  it('no after on an empty table is an empty page, no error', async () => {
    expect(await feed({ after: null })).toEqual({ status: 'ok', events: [], has_more: false })
  })

  it('returns events in seq order with their record fields', async () => {
    const t = await newTask()
    const id = uuidv7()
    await e.run(emit(id, t))
    const [ev] = (await page({})).events
    expect(ev).toMatchObject({ id, type: 'task.created', resource_type: 'task', resource_id: t, actor_id: e.userId, created_at: AT, before: null })
    expect((ev!.after as { id: string }).id).toBe(t)
    expect(ev).not.toHaveProperty('seq')
  })

  it('after equal to the newest event is an empty page with nothing more', async () => {
    const evs = [uuidv7(), uuidv7()]
    for (const id of evs) await rawEvent(id, 'task.created', 'task')
    expect(await feed({ after: evs[1]! })).toEqual({ status: 'ok', events: [], has_more: false })
  })

  it('an unknown or malformed after is the unknown-cursor result, never rows', async () => {
    await rawEvent(uuidv7(), 'task.created', 'task')
    expect(await feed({ after: uuidv7() })).toEqual({ status: 'unknown_cursor' })
    expect(await feed({ after: 'not-a-cursor' })).toEqual({ status: 'unknown_cursor' })
    expect(await feed({ after: '' })).toEqual({ status: 'unknown_cursor' })
  })

  it('an empty readable list (or an empty types list) returns nothing, even for an unknown cursor: no existence leak', async () => {
    await rawEvent(uuidv7(), 'task.created', 'task')
    expect(await feed({ readable: [] })).toEqual({ status: 'ok', events: [], has_more: false })
    expect(await feed({ readable: [], after: uuidv7() })).toEqual({ status: 'ok', events: [], has_more: false })
    expect(await feed({ types: [] })).toEqual({ status: 'ok', events: [], has_more: false })
  })

  it('readable and types exclude other types; types is an exact event type', async () => {
    const t1 = uuidv7(), c1 = uuidv7(), t2 = uuidv7(), n1 = uuidv7()
    await rawEvent(t1, 'task.created', 'task')
    await rawEvent(c1, 'contact.created', 'contact')
    await rawEvent(t2, 'task.updated', 'task')
    await rawEvent(n1, 'note.created', 'note')
    expect(ids((await page({ readable: ['task'] })).events)).toEqual([t1, t2])
    expect(ids((await page({ readable: ['task', 'note'] })).events)).toEqual([t1, t2, n1])
    expect(ids((await page({ readable: ['task', 'contact'], types: ['task.updated', 'contact.created'] })).events)).toEqual([c1, t2])
    expect(ids((await page({ readable: ['contact'], types: ['task.updated'] })).events)).toEqual([])
  })

  it('a cursor on an event outside readable still resolves, and the next page starts after it', async () => {
    const c1 = uuidv7(), t1 = uuidv7()
    await rawEvent(c1, 'contact.created', 'contact')
    await rawEvent(t1, 'task.created', 'task')
    expect(ids((await page({ readable: ['task'], after: c1 })).events)).toEqual([t1])
  })

  it('a page of exactly limit rows with more behind it says so, and the next page starts at the right row', async () => {
    const all = Array.from({ length: 5 }, () => uuidv7())
    for (const id of all) await rawEvent(id, 'task.created', 'task')
    const p1 = await page({ limit: 2 })
    expect(ids(p1.events)).toEqual(all.slice(0, 2))
    expect(p1.has_more).toBe(true)
    const p2 = await page({ limit: 2, after: p1.events.at(-1)!.id })
    expect(ids(p2.events)).toEqual(all.slice(2, 4))
    expect(p2.has_more).toBe(true)
    const p3 = await page({ limit: 2, after: p2.events.at(-1)!.id })
    expect(ids(p3.events)).toEqual(all.slice(4))
    expect(p3.has_more).toBe(false)
    const exact = await page({ limit: 5 })
    expect(ids(exact.events)).toEqual(all)
    expect(exact.has_more).toBe(false)
  })

  it('refuses a non-positive or non-integer limit', async () => {
    await expect(feed({ limit: 0 })).rejects.toThrow()
    await expect(feed({ limit: 1.5 })).rejects.toThrow()
  })
})
