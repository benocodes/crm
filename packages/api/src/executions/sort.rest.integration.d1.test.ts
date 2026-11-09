import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openRailKit, TEST_OPS, type RailKit } from '../test/rail-kit.js'
import type { Actor } from '../test/action-kit.js'

// [[CORE188]] D1, D3, D4: `action_executions.list` sorts by id, created_at (queued at), updated_at and done_at (executed at) through the shared
// keyset path, and keeps the operation-based visibility of [[AGT8]] D57. The expectation of every walk is computed here from the stored rows,
// never from the list under test.
let k: RailKit
let both: Actor
let tasksReader: Actor
let notesReader: Actor
let nobody: Actor
let writer: Actor
const T0 = Date.parse('2026-11-06T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000)
const LIST = '/api/v1/action-executions'
const SORTS = ['id', 'created_at', 'updated_at', 'done_at'] as const
const ORDERS = ['asc', 'desc'] as const
type Sort = (typeof SORTS)[number]

/** Queued times: A and B tie, D and E tie. Finished: A and C tie on done_at; D, E, F and H2 stay unfinished (four nulls). H1 and H2 hold the extreme values and are invisible to a tasks reader. */
const seeded: Record<string, string> = {}
beforeAll(async () => {
  k = await openRailKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write'])
  both = await k.actor('both', 'agent', ['tasks:read', 'notes:read'])
  tasksReader = await k.actor('tasksReader', 'agent', ['tasks:read'])
  notesReader = await k.actor('notesReader', 'agent', ['notes:read'])
  nobody = await k.actor('nobody', 'agent', ['contacts:read'])
  const enqueue = async (name: string, s: number, op: keyof typeof TEST_OPS = 'reconcile') => {
    k.setNow(at(s))
    seeded[name] = (await k.enqueue(writer, { text: name, idempotency_key: name }, op)).body.id
  }
  await enqueue('A', 0)
  await enqueue('B', 0)
  await enqueue('C', 1)
  await enqueue('D', 2)
  await enqueue('E', 2)
  await enqueue('F', 3)
  await enqueue('H1', 5, 'never')
  await enqueue('H2', 6, 'never')
  k.setNow(at(10))
  await k.run(seeded.A!)
  k.transport.willDispatch({ kind: 'not_sent', code: 'provider_rejected', message: 'rejected' })
  await k.run(seeded.C!)
  k.setNow(at(11))
  await k.run(seeded.B!)
  k.setNow(at(30))
  await k.run(seeded.H1!)
})

/** Stored order of the executions `ops` allows: null lowest, ties on id in the request's direction. */
const reference = async (operations: string[], sort: Sort, order: 'asc' | 'desc', status?: string): Promise<string[]> => {
  const rows = (await k.execs()).filter((r) => operations.includes(r.operation as string) && (status === undefined || r.status === status))
  const val = (r: Record<string, unknown>) => (r[sort] === null || r[sort] === undefined ? '' : String(r[sort]))
  const asc = [...rows].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : (a.id as string) < (b.id as string) ? -1 : 1))
  return (order === 'asc' ? asc : asc.reverse()).map((r) => r.id as string)
}
const walk = async (actor: Actor, query: string, limit = 2): Promise<{ ids: string[]; pages: number }> => {
  const ids: string[] = []
  let after: string | null = null
  let pages = 0
  do {
    const r = await k.call(actor, 'GET', `${LIST}?${query}&limit=${limit}${after ? `&after=${after}` : ''}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    ids.push(...r.body.data.map((e: { id: string }) => e.id))
    after = r.body.next_cursor
    pages++
  } while (after !== null && pages < 20)
  return { ids, pages }
}
const TASKS_OPS = [TEST_OPS.reconcile]
const ALL_OPS = [TEST_OPS.reconcile, TEST_OPS.never]

describe('sorted walks under visibility: sort x order (CORE188 D1, D3, D4)', () => {
  it('the seed has the ties and nulls the walks need', async () => {
    const rows = await k.execs()
    const col = (c: string) => rows.map((r) => r[c])
    expect(new Set(col('created_at')).size).toBeLessThan(rows.length)
    expect(rows.filter((r) => r.done_at === null)).toHaveLength(4)
    const done = rows.filter((r) => r.done_at !== null).map((r) => r.done_at)
    expect(new Set(done).size).toBeLessThan(done.length)
  })
  for (const sort of SORTS) {
    for (const order of ORDERS) {
      it(`sort=${sort}&order=${order}: every readable execution exactly once, in order, across pages`, async () => {
        const full = await walk(both, `sort=${sort}&order=${order}`)
        expect(full.pages).toBeGreaterThanOrEqual(2)
        expect(full.ids).toEqual(await reference(ALL_OPS, sort, order))
        const partial = await walk(tasksReader, `sort=${sort}&order=${order}`)
        expect(partial.pages).toBeGreaterThanOrEqual(2)
        expect(partial.ids).toEqual(await reference(TASKS_OPS, sort, order))
        const hidden = [seeded.H1!, seeded.H2!]
        for (const id of partial.ids) expect(hidden).not.toContain(id)
        const notes = await walk(notesReader, `sort=${sort}&order=${order}`, 1)
        expect(notes.ids).toEqual(await reference([TEST_OPS.never], sort, order))
      })
    }
  }
  it('done_at puts the unfinished first in asc and last in desc, ties on id in the request direction', async () => {
    const asc = (await walk(both, 'sort=done_at&order=asc', 3)).ids
    const desc = (await walk(both, 'sort=done_at&order=desc', 3)).ids
    const unfinished = (await k.execs()).filter((r) => r.done_at === null).map((r) => r.id as string).sort()
    expect(asc.slice(0, 4)).toEqual(unfinished)
    expect(desc.slice(-4)).toEqual([...unfinished].reverse())
    expect(desc[0]).toBe(seeded.H1)
  })
  it('a status filter combines with a sort and a cursor', async () => {
    for (const [status, sort, order] of [['done', 'done_at', 'desc'], ['queued', 'created_at', 'desc'], ['failed', 'done_at', 'asc'], ['queued', 'done_at', 'asc']] as const) {
      const r = await walk(both, `status=${status}&sort=${sort}&order=${order}`, 1)
      expect(r.ids, `${status} ${sort} ${order}`).toEqual(await reference(ALL_OPS, sort, order, status))
      expect(r.ids.length).toBeGreaterThan(0)
    }
    const failed = await k.call(both, 'GET', `${LIST}?status=failed&sort=done_at&order=desc`)
    expect(failed.body.data.map((e: { id: string }) => e.id)).toEqual([seeded.C])
  })
  it('the sorted page keeps the record shape: the sort value is not added to a record', async () => {
    const r = await k.call(both, 'GET', `${LIST}?sort=done_at&order=desc&limit=1`)
    expect(Object.keys(r.body.data[0]).sort()).toEqual(
      ['action_request_id', 'arguments', 'authorised_by', 'created_at', 'created_by', 'deadline_at', 'done_at', 'error_code', 'error_message', 'id', 'idempotency_key', 'operation', 'organization_id', 'result', 'status', 'updated_at'].sort(),
    )
  })
})

describe('compatibility and refusals (CORE188 D3, D4)', () => {
  it('unsorted: ascending id, a UUID after pages on, next_cursor is a UUID', async () => {
    const p1 = await k.call(both, 'GET', `${LIST}?limit=3`)
    expect(p1.body.data.map((e: { id: string }) => e.id)).toEqual((await reference(ALL_OPS, 'id', 'asc')).slice(0, 3))
    expect(p1.body.next_cursor).toBe(p1.body.data[2].id)
    const p2 = await k.call(both, 'GET', `${LIST}?limit=3&after=${p1.body.next_cursor}`)
    expect(p2.body.data.map((e: { id: string }) => e.id)).toEqual((await reference(ALL_OPS, 'id', 'asc')).slice(3, 6))
  })
  const refused = async (actor: Actor, query: string, message: RegExp) => {
    const r = await k.call(actor, 'GET', `${LIST}?${query}`)
    expect([r.status, r.body.error?.code], query).toEqual([400, 'validation_error'])
    expect(r.body.error.message, query).toMatch(message)
  }
  it('refuses an unknown sort (dispatched_at, a lease column) with the sort list', async () => {
    await refused(both, 'sort=dispatched_at', /sort must be one of: id, created_at, updated_at, done_at/)
    await refused(both, 'sort=status', /sort must be one of/)
  })
  it('refuses order without sort, a UUID after with sort, a sorted cursor without sort, and a cursor of another sort or order', async () => {
    await refused(both, 'order=desc', /order needs sort/)
    await refused(both, `sort=done_at&after=${seeded.A}`, /not a valid cursor|cursor/)
    const cursor = (await k.call(both, 'GET', `${LIST}?sort=done_at&order=desc&limit=1`)).body.next_cursor as string
    expect(cursor).not.toMatch(/^[0-9a-f]{8}-/)
    await refused(both, `after=${cursor}`, /after must be a UUID/)
    await refused(both, `sort=created_at&order=desc&after=${cursor}`, /not a valid cursor/)
    await refused(both, `sort=done_at&order=asc&after=${cursor}`, /not a valid cursor/)
  })
  it('a caller with no readable operation gets an empty page, sorted or not, and a malformed after is still 400', async () => {
    for (const q of ['', 'sort=done_at', 'sort=created_at&order=desc', 'status=done&sort=updated_at']) {
      const r = await k.call(nobody, 'GET', `${LIST}?${q}`)
      expect([r.status, r.body], q).toEqual([200, { data: [], next_cursor: null }])
    }
    await refused(nobody, 'after=not-a-uuid', /after must be a UUID/)
    await refused(nobody, 'sort=done_at&after=not-a-cursor', /not a valid cursor/)
    await refused(nobody, 'sort=dispatched_at', /sort must be one of/)
  })
  it('a creator sees only what its own read scopes allow, sorted', async () => {
    const r = await k.call(writer, 'GET', `${LIST}?sort=done_at&order=desc`)
    expect(r.body.data.map((e: { id: string }) => e.id)).toEqual(await reference(TASKS_OPS, 'done_at', 'desc'))
  })
})

describe('the approval time and the queued time agree (CORE188 D2)', () => {
  it('for an approved request, the execution created_at equals the request decided_at', async () => {
    const reviewer = await k.actor('reviewer', 'agent', ['tasks:write', 'tasks:read', 'action_requests:read'])
    k.setNow(at(100))
    const queued = (await k.call(reviewer, 'POST', '/api/v1/action-requests', { operation: TEST_OPS.reconcile, arguments: { text: 'q' }, reason: 'r' })).body
    k.setNow(at(105))
    const approved = (await k.call(reviewer, 'POST', `/api/v1/action-requests/${queued.id}/approve`)).body
    const execution = (await k.call(both, 'GET', `${LIST}/${approved.execution_id}`)).body
    const request = (await k.call(reviewer, 'GET', `/api/v1/action-requests/${queued.id}`)).body
    expect(request.decided_at).toBe(at(105).toISOString())
    expect(execution.created_at).toBe(request.decided_at)
  })
})
