import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openRailKit, TEST_OPS, type RailKit } from '../test/rail-kit.js'
import type { Actor } from '../test/action-kit.js'

// [[AGT8]] D57: execution reads. The read scope is the operation's (declared on it); list shows only what the caller may read; get of an unreadable and
// of a missing id answer the same 404; the projection hides the machinery and every raw provider text.
let k: RailKit
let writer: Actor
let tasksReader: Actor
let notesReader: Actor
let both: Actor
let nobody: Actor
let eTasks: string
let eNever: string
beforeAll(async () => {
  k = await openRailKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write'])
  tasksReader = await k.actor('tasksReader', 'agent', ['tasks:read'])
  notesReader = await k.actor('notesReader', 'agent', ['notes:read'])
  both = await k.actor('both', 'agent', ['tasks:read', 'notes:read'])
  nobody = await k.actor('nobody', 'agent', ['contacts:read'])
  eTasks = (await k.enqueue(writer, { text: 'a', idempotency_key: 'a' }, 'reconcile')).body.id
  eNever = (await k.enqueue(writer, { text: 'b', idempotency_key: 'b' }, 'never')).body.id
})
const LIST = '/api/v1/action-executions'
const ids = (r: { body: any }) => (r.body.data as Array<{ id: string }>).map((e) => e.id).sort()

describe('list and get follow the operation\'s read scope', () => {
  it('list shows only the executions whose read scope the caller holds', async () => {
    expect(ids(await k.call(tasksReader, 'GET', LIST))).toEqual([eTasks])
    expect(ids(await k.call(notesReader, 'GET', LIST))).toEqual([eNever])
    expect(ids(await k.call(both, 'GET', LIST))).toEqual([eTasks, eNever].sort())
    const empty = await k.call(nobody, 'GET', LIST)
    expect([empty.status, empty.body]).toEqual([200, { data: [], next_cursor: null }])
  })

  it('get of an unreadable id and of a missing id are the same 404, byte for byte', async () => {
    const unreadable = await k.call(tasksReader, 'GET', `${LIST}/${eNever}`)
    const missing = await k.call(tasksReader, 'GET', `${LIST}/00000000-0000-7000-8000-000000000000`)
    expect(unreadable.status).toBe(404)
    expect(JSON.stringify(unreadable)).toBe(JSON.stringify(missing))
    expect((await k.call(tasksReader, 'GET', `${LIST}/${eTasks}`)).status).toBe(200)
    expect((await k.call(notesReader, 'GET', `${LIST}/${eTasks}`)).status).toBe(404)
    expect((await k.call(both, 'GET', `${LIST}/${eNever}`)).status).toBe(200)
  })

  it('a creator reads only what its own read scopes allow: tasks:read shows the tasks execution, not the notes one', async () => {
    expect(ids(await k.call(writer, 'GET', LIST))).toEqual([eTasks]) // tasks:read is in its set, notes:read is not
    expect((await k.call(writer, 'GET', `${LIST}/${eNever}`)).status).toBe(404)
  })

  it('filters by status and operation and pages with a cursor', async () => {
    k.setNow(new Date(k.now().getTime() + 1000))
    await k.run(eTasks)
    expect(ids(await k.call(both, 'GET', `${LIST}?status=done`))).toEqual([eTasks])
    expect(ids(await k.call(both, 'GET', `${LIST}?status=queued`))).toEqual([eNever])
    expect(ids(await k.call(both, 'GET', `${LIST}?operation=${TEST_OPS.never}`))).toEqual([eNever])
    const page1 = await k.call(both, 'GET', `${LIST}?limit=1`)
    expect(page1.body.data).toHaveLength(1)
    expect(page1.body.next_cursor).toBe(page1.body.data[0].id)
    const page2 = await k.call(both, 'GET', `${LIST}?limit=1&after=${page1.body.next_cursor}`)
    expect(page2.body.data).toHaveLength(1)
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id)
    expect(page2.body.next_cursor).toBeNull()
  })
})

describe('the projection (D57)', () => {
  it('shows the safe columns and never the machinery or a raw transport error', async () => {
    k.transport.willDispatch({ kind: 'not_sent', code: 'provider_rejected', message: 'RAW-SECRET-TEXT refresh_token=1//abc' })
    k.setNow(new Date(k.now().getTime() + 1000))
    await k.run(eTasks)
    const got = (await k.call(both, 'GET', `${LIST}/${eTasks}`)).body
    expect(Object.keys(got).sort()).toEqual(
      ['action_request_id', 'arguments', 'authorised_by', 'created_at', 'created_by', 'deadline_at', 'done_at', 'error_code', 'error_message', 'id', 'idempotency_key', 'operation', 'organization_id', 'result', 'status', 'updated_at'].sort(),
    )
    expect(got).toMatchObject({ status: 'failed', error_code: 'provider_rejected' })
    const everything = JSON.stringify([got, (await k.call(both, 'GET', LIST)).body, await k.events()])
    for (const secret of ['lease_token', 'lease_until', 'next_attempt_at', 'input_hash', 'RAW-SECRET-TEXT', 'refresh_token', 'dispatched_at', 'client_ref']) expect(everything).not.toContain(secret)
  })

  it('a queued execution has no result and no error', async () => {
    const got = (await k.call(both, 'GET', `${LIST}/${eNever}`)).body
    expect(got).toMatchObject({ status: 'queued', result: null, error_code: null, error_message: null, done_at: null, action_request_id: null, authorised_by: writer.id })
  })
})

describe('the request shows its execution (D48)', () => {
  it('execution_id is null until a queued approval creates one', async () => {
    const reviewer = await k.actor('reviewer', 'agent', ['tasks:write', 'tasks:read', 'action_requests:read'])
    const plain = (await k.call(reviewer, 'POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: 'p' }, reason: 'r' })).body
    expect(plain.execution_id ?? null).toBeNull()
    const queued = (await k.call(reviewer, 'POST', '/api/v1/action-requests', { operation: TEST_OPS.reconcile, arguments: { text: 'q' }, reason: 'r' })).body
    expect(queued.execution_id ?? null).toBeNull()
    const approved = await k.call(reviewer, 'POST', `/api/v1/action-requests/${queued.id}/approve`)
    expect(approved.body.execution_id).toEqual(expect.any(String))
    const listed = (await k.call(reviewer, 'GET', `/api/v1/action-requests?status=approved`)).body.data[0]
    expect(listed.execution_id).toBe(approved.body.execution_id)
  })
})
