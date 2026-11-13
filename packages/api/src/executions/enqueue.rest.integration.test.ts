import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openRailKit, TEST_OPS, type RailKit } from '../test/rail-kit.js'
import type { Actor } from '../test/action-kit.js'
import { deriveTools } from '../mcp/tools.js'

// [[AGT8]] D11, D48-D51: an enqueued operation, called directly or approved from a request, authorises exactly one durable execution. The concurrent
// writer is the kit's `beforeCommit` hook (after a unit's plan reads, before its commit batch).
let k: RailKit
let owner: Actor
let writer: Actor
let writer2: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openRailKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.owner
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write', 'action_requests:read'])
  writer2 = await k.actor('writer2', 'agent', ['tasks:read', 'tasks:write'])
  proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'action_requests:read'])
})
const AR = '/api/v1/action-requests'
const code = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const propose = async (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => (await k.call(proposer, 'POST', AR, { operation: TEST_OPS.reconcile, arguments: args, reason: 'please', ...extra })).body.id as string
const events = async (type: string) => k.events(type)

describe('direct enqueue and idempotency (D51)', () => {
  it('a call without idempotency_key is refused and writes nothing', async () => {
    const r = await k.enqueue(writer, { text: 'hello' })
    expect(code(r)).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain('idempotency_key')
    expect(await k.execs()).toEqual([])
    expect(k.starts).toBe(0)
  })

  it('answers 202 with the execution receipt: one queued row, one action_execution.created, the runner started once', async () => {
    const r = await k.enqueue(writer, { text: 'hello', idempotency_key: 'k1' })
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({
      operation: TEST_OPS.reconcile,
      status: 'queued',
      arguments: { text: 'hello' },
      action_request_id: null,
      created_by: writer.id,
      authorised_by: writer.id,
      idempotency_key: 'k1',
      result: null,
      error_code: null,
      error_message: null,
      done_at: null,
    })
    const rows = await k.execs()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: r.body.id, status: 'queued', attempts: 0, resolution: { anchor: 'anchor-1' }, action_request_id: null, lease_token: null, dispatched_at: null })
    expect(rows[0]!.client_ref).toBe(`${r.body.id}@test.invalid`)
    expect(Date.parse(rows[0]!.deadline_at as string) - k.now().getTime()).toBe(10 * 60_000)
    expect(rows[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/)
    const created = await events('action_execution.created')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ actor_id: writer.id, resource_type: 'action_execution', resource_id: r.body.id, before: null })
    expect((created[0]!.after as Record<string, unknown>).status).toBe('queued')
    expect(k.starts).toBe(1)
  })

  it('OPS265 D13: an execution authorised with no clientRefDomain stores the default {execution_id}@vibase.invalid', async () => {
    const r = await k.enqueue(writer, { text: 'x', no_domain: true, idempotency_key: 'k-default' })
    expect(r.status).toBe(202)
    expect((await k.exec(r.body.id)).client_ref).toBe(`${r.body.id}@vibase.invalid`)
  })

  it('the same key and the same input answer the same execution and write nothing (key order does not matter)', async () => {
    const first = await k.enqueue(writer, { text: 'x', anchor: 'a', idempotency_key: 'k1' })
    const eventsBefore = (await k.events()).length
    const again = await k.enqueue(writer, { idempotency_key: 'k1', anchor: 'a', text: 'x' })
    expect(again.status).toBe(202)
    expect(again.body.id).toBe(first.body.id)
    expect(await k.execs()).toHaveLength(1)
    expect((await k.events()).length).toBe(eventsBefore)
    expect(await events('action_execution.created')).toHaveLength(1)
  })

  it('the same key with changed input is 409 idempotency_key_reused and leaves the first execution as it was', async () => {
    const first = await k.enqueue(writer, { text: 'x', idempotency_key: 'k1' })
    const changed = await k.enqueue(writer, { text: 'y', idempotency_key: 'k1' })
    expect(code(changed)).toEqual([409, 'idempotency_key_reused'])
    const rows = await k.execs()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: first.body.id, arguments: { text: 'x' } })
  })

  it('the same key and arguments on another operation are 409 idempotency_key_reused (the operation is in the hash)', async () => {
    await k.enqueue(writer, { text: 'x', idempotency_key: 'k1' }, 'reconcile')
    const other = await k.enqueue(writer, { text: 'x', idempotency_key: 'k1' }, 'idempotent')
    expect(code(other)).toEqual([409, 'idempotency_key_reused'])
    expect(await k.execs()).toHaveLength(1)
  })

  it('two principals with the same key get two executions', async () => {
    const a = await k.enqueue(writer, { text: 'x', idempotency_key: 'reply-1' })
    const b = await k.enqueue(writer2, { text: 'x', idempotency_key: 'reply-1' })
    expect([a.status, b.status]).toEqual([202, 202])
    expect(b.body.id).not.toBe(a.body.id)
    expect((await k.execs()).map((r) => r.created_by).sort()).toEqual([writer.id, writer2.id].sort())
    expect(await events('action_execution.created')).toHaveLength(2)
  })

  it('a same-key call that commits between plan and commit is replanned and answers the winner, one row', async () => {
    let winner: { status: number; body: any } | undefined
    k.beforeCommit(async () => {
      winner = await k.enqueue(writer, { text: 'x', idempotency_key: 'race' })
    })
    const mine = await k.enqueue(writer, { text: 'x', idempotency_key: 'race' })
    expect(winner?.status).toBe(202)
    expect(mine.status).toBe(202)
    expect(mine.body.id).toBe(winner!.body.id)
    expect(await k.execs()).toHaveLength(1)
    expect(await events('action_execution.created')).toHaveLength(1)
  })

  it('a replay answers the original execution even when authorise would now refuse; a changed input under the key is still 409 (D61)', async () => {
    const first = await k.enqueue(writer, { text: 'x', once: 'tok', idempotency_key: 'k1' })
    expect(first.status).toBe(202)
    const again = await k.enqueue(writer, { text: 'x', once: 'tok', idempotency_key: 'k1' })
    expect([again.status, again.body.id]).toEqual([202, first.body.id])
    expect(code(await k.enqueue(writer, { text: 'y', once: 'tok', idempotency_key: 'k1' }))).toEqual([409, 'idempotency_key_reused'])
    // A NEW key with the same token is authorised, and refused.
    expect(code(await k.enqueue(writer, { text: 'x', once: 'tok', idempotency_key: 'k2' }))).toEqual([409, 'anchor_retracted'])
    expect(await k.execs()).toHaveLength(1)
  })

  it('a caller without the write scope is refused and writes nothing; a proposer is told how to propose', async () => {
    const none = await k.enqueue(await k.actor('reader', 'agent', ['tasks:read']), { text: 'x', idempotency_key: 'k' })
    expect(code(none)).toEqual([403, 'insufficient_scope'])
    const prop = await k.enqueue(proposer, { text: 'x', idempotency_key: 'k' })
    expect(code(prop)).toEqual([403, 'insufficient_scope'])
    expect(prop.body.error.message).toContain(`call action_requests.create with operation=${TEST_OPS.reconcile}`)
    expect(await k.execs()).toEqual([])
    expect(k.starts).toBe(0)
  })

  it('an unknown argument is a 400 and writes nothing', async () => {
    expect(code(await k.enqueue(writer, { text: 'x', nope: 1, idempotency_key: 'k' }))).toEqual([400, 'validation_error'])
    expect(await k.execs()).toEqual([])
  })
})

describe('queued approval is one unit (D49)', () => {
  it('approving creates the request decision, one execution and both events together; the approver is the authoriser', async () => {
    const id = await propose({ text: 'approve me' })
    expect(await k.execs()).toEqual([]) // proposing creates no execution
    const r = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(r.status).toBe(200)
    const executionId = r.body.execution_id as string
    expect(r.body).toMatchObject({ status: 'approved', decided_by: writer.id, executed_at: null, execution_id: executionId })
    const rows = await k.execs()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: executionId,
      status: 'queued',
      action_request_id: id,
      created_by: proposer.id,
      authorised_by: writer.id,
      idempotency_key: null,
      arguments: { text: 'approve me' },
      resolution: { anchor: 'anchor-1' },
    })
    expect(Date.parse(rows[0]!.deadline_at as string) - k.now().getTime()).toBe(10 * 60_000)
    const approved = await events('action_request.approved')
    const created = await events('action_execution.created')
    expect(approved.map((e) => e.actor_id)).toEqual([writer.id])
    expect(created.map((e) => [e.actor_id, e.resource_id])).toEqual([[writer.id, executionId]])
    expect(await events('action_request.executed')).toEqual([])
    expect(k.starts).toBe(1)
    expect((await k.call(owner, 'GET', `${AR}/${id}`)).body.execution_id).toBe(executionId)
  })

  it('edited_arguments become the execution arguments; the request keeps its original', async () => {
    const id = await propose({ text: 'original' })
    const r = await k.call(owner, 'POST', `${AR}/${id}/approve`, { edited_arguments: { text: 'edited' } })
    expect(r.status).toBe(200)
    expect((await k.execs())[0]).toMatchObject({ arguments: { text: 'edited' } })
    expect((await k.rows('action_requests', 'id = ?', id))[0]).toMatchObject({ arguments: { text: 'original' }, edited_arguments: { text: 'edited' } })
  })

  it('an idempotency_key in the proposal is ignored: an approved execution carries none', async () => {
    const id = await propose({ text: 'x', idempotency_key: 'ignored' })
    expect((await k.call(writer, 'POST', `${AR}/${id}/approve`)).status).toBe(200)
    expect((await k.execs())[0]).toMatchObject({ idempotency_key: null, arguments: { text: 'x' } })
  })

  it('a refusal at final validation leaves the request pending with no execution and no kick', async () => {
    const id = await propose({ text: 'x' })
    const eventsBefore = (await k.events()).length
    const r = await k.call(owner, 'POST', `${AR}/${id}/approve`, { edited_arguments: { text: 'x', refuse: true } })
    expect(code(r)).toEqual([409, 'test_refused'])
    expect((await k.rows('action_requests', 'id = ?', id))[0]).toMatchObject({ status: 'pending', decided_by: null, decided_at: null })
    expect(await k.execs()).toEqual([])
    expect((await k.events()).length).toBe(eventsBefore)
    expect(k.starts).toBe(0)
  })

  it('edited arguments that fail the operation schema are a 400 and leave the request pending', async () => {
    const id = await propose({ text: 'x' })
    const r = await k.call(owner, 'POST', `${AR}/${id}/approve`, { edited_arguments: { text: '' } })
    expect(code(r)).toEqual([400, 'validation_error'])
    expect((await k.rows('action_requests', 'id = ?', id))[0]!.status).toBe('pending')
    expect(await k.execs()).toEqual([])
  })

  it('a proposal-only principal cannot approve', async () => {
    const id = await propose({ text: 'x' })
    expect(code(await k.call(proposer, 'POST', `${AR}/${id}/approve`))).toEqual([403, 'insufficient_scope'])
    expect(await k.execs()).toEqual([])
  })

  it('two approvals racing yield one execution (D28 drift)', async () => {
    const id = await propose({ text: 'x' })
    let other: { status: number; body: any } | undefined
    k.beforeCommit(async () => {
      other = await k.call(owner, 'POST', `${AR}/${id}/approve`)
    })
    const mine = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(other?.status).toBe(200)
    expect(code(mine)).toEqual([409, 'action_request_not_pending'])
    expect(await k.execs()).toHaveLength(1)
    expect(await events('action_execution.created')).toHaveLength(1)
    expect((await k.execs())[0]!.authorised_by).toBe(owner.id)
  })

  it('a withdrawal committing between the approval plan and its commit leaves no execution (the transition gate)', async () => {
    const id = await propose({ text: 'x' })
    k.beforeCommit(async () => {
      await k.call(proposer, 'POST', `${AR}/${id}/withdraw`)
    })
    const r = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(code(r)).toEqual([409, 'action_request_not_pending'])
    expect((await k.rows('action_requests', 'id = ?', id))[0]!.status).toBe('withdrawn')
    expect(await k.execs()).toEqual([])
    expect(await events('action_execution.created')).toEqual([])
    expect(await events('action_request.approved')).toEqual([])
  })

  it('a resolution guard failing at commit writes nothing: the request stays pending, the answer is 409 conflict', async () => {
    const task = (await k.call(owner, 'POST', '/api/v1/tasks', { title: 'anchor' })).body.id as string
    const id = await propose({ text: 'x', guard_task: task })
    const wipe = async () => {
      await k.call(owner, 'DELETE', `/api/v1/tasks/${task}`)
    }
    // Each attempt (the plan and its one replan) has two read batches and a commit batch; the task goes before the first commit and stays gone.
    k.beforeCommit(wipe)
    const r = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(r.status).toBe(409)
    expect((await k.rows('action_requests', 'id = ?', id))[0]).toMatchObject({ status: 'pending', decided_by: null })
    expect(await k.execs()).toEqual([])
    expect(await events('action_execution.created')).toEqual([])
    expect(k.starts).toBe(0)
  })
})

describe('discovery (D40, D51, D57)', () => {
  it('the enqueued operation is in OpenAPI with a required idempotency_key and a 202, and in MCP with the key required', async () => {
    const doc = (await (await k.app.request('/api/v1/openapi.json')).json()) as any
    const op = doc.paths['/api/v1/test-enqueue'].post
    expect(Object.keys(op.responses)).toContain('202')
    const body = op.requestBody.content['application/json'].schema
    expect(body.required).toContain('idempotency_key')
    expect(body.properties.idempotency_key).toMatchObject({ type: 'string', minLength: 1, maxLength: 200 })
    expect(op['x-vault-proposal']).toMatchObject({ eligible: true, request_scope: 'tasks:request_approval' })
    const enumValues = (doc.paths['/api/v1/action-requests'].post.requestBody.content['application/json'].schema.properties.operation.enum as string[]) ?? []
    expect(enumValues).toContain(TEST_OPS.reconcile)
  })

  it('MCP derives the same: the enqueued tool requires idempotency_key, and the two execution reads are tools', () => {
    const tools = new Map(deriveTools(k.registry).map((t) => [t.tool.name, t.tool]))
    const send = tools.get('test_enqueue')!
    expect((send.inputSchema as any).required).toEqual(expect.arrayContaining(['text', 'idempotency_key']))
    expect(send.description).toContain('idempotency_key is required')
    expect(send.description).toContain('Proposable: tasks:request_approval')
    expect(tools.has('action_executions_list')).toBe(true)
    expect(tools.get('action_executions_get')!.annotations.readOnlyHint).toBe(true)
  })

  it('the executions are readable through the registry: action_executions.list and .get on /api/v1', async () => {
    const names = k.registry.operations().map((o) => o.name)
    expect(names).toContain('action_executions.list')
    expect(names).toContain('action_executions.get')
    const doc = (await (await k.app.request('/api/v1/openapi.json')).json()) as any
    expect(doc.paths['/api/v1/action-executions'].get).toBeDefined()
    expect(doc.paths['/api/v1/action-executions/{id}'].get).toBeDefined()
  })
})
