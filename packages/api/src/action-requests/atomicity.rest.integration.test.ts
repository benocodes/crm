import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'

// [[AGT8]] D10, D28, D35: an inline approval is one unit with its target, and a decision racing another is exactly one outcome. The concurrent
// writer is the `beforeCommit` hook: it runs after the unit's plan reads and before its commit batch, on the same database.
let k: ActionKit
let owner: Actor
let writer: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.owner
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write', 'contacts:write', 'deals:write', 'pipelines:write', 'action_requests:read'])
  proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'contacts:request_approval', 'deals:request_approval', 'action_requests:read'])
})
const AR = '/api/v1/action-requests'
const post = async (path: string, body: unknown) => (await k.call(owner, 'POST', path, body)).body
const propose = async (operation: string, args: Record<string, unknown>) => (await k.call(proposer, 'POST', AR, { operation, arguments: args, reason: 'x' })).body.id as string
const code = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]
const statusOf = async (id: string) => (await k.rows('action_requests', 'id = ?', id))[0]!.status
const touch = (table: string, id: string, set: string) => k.d1.prepare(`update "${table}" set ${set} where id = ?`).bind(id).run()
const LATER = '2026-11-06T10:00:01.000Z'

/**
 * Runs `actions` one per batch, in order (null: let that batch pass; a hook armed at the commit batch fires before it). An approval has two
 * read batches per attempt (the request's plan, then the target's) and then the commit batch: `[null, change]` changes the world after the
 * target's plan, once; a second drifting attempt needs `[null, change, null, null, change]`.
 */
function afterReads(actions: Array<(() => Promise<void>) | null>): void {
  const [next, ...rest] = actions
  if (next === undefined) return
  k.beforeCommit(async () => {
    if (next) await next()
    afterReads(rest)
  })
}

/** Nothing of the decision exists: no event of the request's decision, no target event, the request pending. */
async function expectUntouched(id: string, eventsBefore: number) {
  expect(await statusOf(id)).toBe('pending')
  expect((await k.events()).length).toBe(eventsBefore)
  expect((await k.rows('action_requests', 'id = ?', id))[0]).toMatchObject({ decided_by: null, decided_at: null, result: null, executed_at: null })
}

describe('concurrent decisions: exactly one outcome and one target mutation (D28)', () => {
  it('two approvals racing: one executes, the other is 409 action_request_not_pending, one task.updated', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'once' })
    let other: { status: number; body: any } | undefined
    k.beforeCommit(async () => {
      other = await k.call(owner, 'POST', `${AR}/${id}/approve`)
    })
    const mine = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(other?.status).toBe(200)
    expect(code(mine)).toEqual([409, 'action_request_not_pending'])
    expect((await k.events('task.updated')).map((e) => e.actor_id)).toEqual([owner.id])
    expect(await statusOf(id)).toBe('executed')
  })

  it('approve racing withdraw: the withdraw wins, the approval is 409 and the task is untouched', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'never' })
    k.beforeCommit(async () => {
      await k.call(proposer, 'POST', `${AR}/${id}/withdraw`)
    })
    const r = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(code(r)).toEqual([409, 'action_request_not_pending'])
    expect(await statusOf(id)).toBe('withdrawn')
    expect(await k.events('task.updated')).toEqual([])
    expect((await k.call(owner, 'GET', `/api/v1/tasks/${t}`)).body.title).toBe('start')
  })

  it('withdraw racing approve: the approval wins and the withdraw is 409', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'done' })
    k.beforeCommit(async () => {
      await k.call(writer, 'POST', `${AR}/${id}/approve`)
    })
    expect(code(await k.call(proposer, 'POST', `${AR}/${id}/withdraw`))).toEqual([409, 'action_request_not_pending'])
    expect(await statusOf(id)).toBe('executed')
  })

  it('two proposers racing for one dedup_key: one request, the other 409 duplicate_action_request', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    let other: { status: number; body: any } | undefined
    k.beforeCommit(async () => {
      other = await k.call(owner, 'POST', AR, { operation: 'tasks.update', arguments: { id: t, title: 'o' }, reason: 'x', dedup_key: 'race' })
    })
    const mine = await k.call(proposer, 'POST', AR, { operation: 'tasks.update', arguments: { id: t, title: 'p' }, reason: 'x', dedup_key: 'race' })
    expect(other?.status).toBe(201)
    expect(code(mine)).toEqual([409, 'duplicate_action_request'])
    expect(await k.rows('action_requests', "status = 'pending'")).toHaveLength(1)
  })
})

describe('inline atomicity (D10, D35): a guard failing at commit leaves no decision, no target row and no events', () => {
  it('the stamp guard: a target changed after the plan drifts once, the replan sees it and succeeds (one replan)', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'final' })
    let touched = 0
    afterReads([null, async () => void (await touch('tasks', t, `updated_at = '${LATER}'`), touched++)])
    const r = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(touched).toBe(1)
    expect(r.status).toBe(200)
    expect(await k.events('task.updated')).toHaveLength(1)
    expect(await k.events('action_request.executed')).toHaveLength(1)
  })

  it('drift twice is 409 conflict and nothing is written', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'final' })
    const before = (await k.events()).length
    let n = 0
    const change = async () => void (await touch('tasks', t, `updated_at = '2026-11-06T10:00:0${++n + 1}.000Z'`))
    afterReads([null, change, null, null, change])
    const r = await k.call(writer, 'POST', `${AR}/${id}/approve`)
    expect(n).toBe(2)
    expect(code(r)).toEqual([409, 'conflict'])
    await expectUntouched(id, before)
    expect((await k.call(owner, 'GET', `/api/v1/tasks/${t}`)).body.title).toBe('start')
  })

  it('the target deleted after the plan: the replan finds nothing, the answer is the target\'s 404, the request stays pending', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'final' })
    const before = (await k.events()).length
    afterReads([null, async () => void (await touch('tasks', t, `deleted_at = '${LATER}', updated_at = '${LATER}'`))])
    expect(code(await k.call(writer, 'POST', `${AR}/${id}/approve`))).toEqual([404, 'not_found'])
    await expectUntouched(id, before)
  })

  it('a reference guard: a company deleted after the plan, answered as the target\'s invalid_reference, nothing written', async () => {
    const company = (await post('/api/v1/companies', { name: 'Acme' })).id
    const c = (await post('/api/v1/contacts', { name: 'Ann' })).id
    const id = await propose('contacts.update', { id: c, company_id: company })
    const before = (await k.events()).length
    afterReads([null, async () => void (await touch('companies', company, `deleted_at = '${LATER}', updated_at = '${LATER}'`))])
    expect(code(await k.call(writer, 'POST', `${AR}/${id}/approve`))).toEqual([400, 'invalid_reference'])
    await expectUntouched(id, before)
    expect((await k.rows('contacts', 'id = ?', c))[0]!.company_id).toBeNull()
  })

  it('a command guard: the stage of a deal move deleted after the plan', async () => {
    const pipeline = (await post('/meta/v1/pipelines', { name: 'Sales' })).id
    const open = (await post('/meta/v1/pipeline-stages', { pipeline_id: pipeline, name: 'Open', kind: 'open', position: 1 })).id
    const won = (await post('/meta/v1/pipeline-stages', { pipeline_id: pipeline, name: 'Won', kind: 'won', position: 2 })).id
    const deal = (await post('/api/v1/deals', { name: 'D', stage_id: open })).id
    const id = await propose('deals.move_stage', { id: deal, stage_id: won })
    const before = (await k.events()).length
    afterReads([null, async () => void (await touch('pipeline_stages', won, `deleted_at = '${LATER}', updated_at = '${LATER}'`))])
    expect(code(await k.call(writer, 'POST', `${AR}/${id}/approve`))).toEqual([400, 'invalid_reference'])
    await expectUntouched(id, before)
    expect((await k.rows('deals', 'id = ?', deal))[0]!.stage_id).toBe(open)
  })

  it('a target that refuses on its plan (a stale proposal) answers its own error and leaves the request pending', async () => {
    const t = (await post('/api/v1/tasks', { title: 'start' })).id
    const id = await propose('tasks.update', { id: t, title: 'final' })
    await k.call(owner, 'DELETE', `/api/v1/tasks/${t}`)
    const before = (await k.events()).length
    expect(code(await k.call(writer, 'POST', `${AR}/${id}/approve`))).toEqual([404, 'not_found'])
    await expectUntouched(id, before)
  })
})
