import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'

// [[AGT8]] D2, D32, D34: one generic path. A proposal for a create, an update, a delete, a command and an operation under a shared scope resource
// (a pipeline stage under `pipelines`) is refused exactly as the direct call is for the same bad input, and an association refuses a proposer
// lacking read on one endpoint type as the direct call does.
let k: ActionKit
let writer: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  const scopes = ['tasks', 'deals', 'pipelines', 'associations', 'contacts']
  writer = await k.actor('writer', 'agent', scopes.flatMap((r) => [`${r}:read`, `${r}:write`]))
  proposer = await k.actor('proposer', 'agent', scopes.flatMap((r) => [`${r}:read`, `${r}:request_approval`]))
})
const post = async (path: string, body: unknown) => (await k.call(k.owner, 'POST', path, body)).body
const AR = '/api/v1/action-requests'
const shape = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.message]

/** The direct call as a writer and the proposal as a proposer give the same refusal. */
async function same(label: string, direct: { method: string; path: string; body?: unknown }, operation: string, args: Record<string, unknown>, expected: [number, string]) {
  const d = await k.call(writer, direct.method, direct.path, direct.body)
  const p = await k.call(proposer, 'POST', AR, { operation, arguments: args, reason: 'bad input' })
  expect(shape(d).slice(0, 2), `${label}: the direct call`).toEqual(expected)
  expect(shape(p), `${label}: the proposal`).toEqual(shape(d))
  expect(await k.rows('action_requests'), `${label}: nothing stored`).toEqual([])
}

describe('a proposal is refused as the direct call is', () => {
  it('create: a bad body', async () => {
    await same('tasks.create', { method: 'POST', path: '/api/v1/tasks', body: { title: '' } }, 'tasks.create', { title: '' }, [400, 'validation_error'])
  })
  it('update: a bad body on an existing record', async () => {
    const t = (await post('/api/v1/tasks', { title: 'a' })).id
    await same('tasks.update', { method: 'PATCH', path: `/api/v1/tasks/${t}`, body: { title: '' } }, 'tasks.update', { id: t, title: '' }, [400, 'validation_error'])
  })
  it('update and delete: a record that does not exist, and an id that is not one', async () => {
    const missing = '0190b2c4-0000-7000-8000-00000000dead'
    await same('tasks.update missing', { method: 'PATCH', path: `/api/v1/tasks/${missing}`, body: { title: 'x' } }, 'tasks.update', { id: missing, title: 'x' }, [404, 'not_found'])
    await same('tasks.delete missing', { method: 'DELETE', path: `/api/v1/tasks/${missing}` }, 'tasks.delete', { id: missing }, [404, 'not_found'])
    await same('tasks.delete not a uuid', { method: 'DELETE', path: '/api/v1/tasks/nope' }, 'tasks.delete', { id: 'nope' }, [404, 'not_found'])
  })
  it('command: deals.move_stage with a stage that is not a uuid', async () => {
    const pipeline = (await post('/meta/v1/pipelines', { name: 'S' })).id
    const stage = (await post('/meta/v1/pipeline-stages', { pipeline_id: pipeline, name: 'Open', kind: 'open', position: 1 })).id
    const deal = (await post('/api/v1/deals', { name: 'D', stage_id: stage })).id
    await same('deals.move_stage', { method: 'POST', path: `/api/v1/deals/${deal}/move-stage`, body: { stage_id: 'x' } }, 'deals.move_stage', { id: deal, stage_id: 'x' }, [400, 'validation_error'])
  })
  it('a shared scope resource: a stage is proposed under pipelines', async () => {
    const pipeline = (await post('/meta/v1/pipelines', { name: 'S' })).id
    await same('pipeline_stages.create', { method: 'POST', path: '/meta/v1/pipeline-stages', body: { pipeline_id: pipeline, name: 'x', kind: 'maybe', position: 1 } }, 'pipeline_stages.create', { pipeline_id: pipeline, name: 'x', kind: 'maybe', position: 1 }, [400, 'validation_error'])
    const stagesOnly = await k.actor('stages', 'agent', ['pipelines:request_approval'])
    const ok = await k.call(stagesOnly, 'POST', AR, { operation: 'pipeline_stages.create', arguments: { pipeline_id: pipeline, name: 'Open', kind: 'open', position: 1 }, reason: 'r' })
    expect(ok.status).toBe(201)
    const wrong = await k.actor('wrong', 'agent', ['deals:request_approval'])
    const refused = await k.call(wrong, 'POST', AR, { operation: 'pipeline_stages.create', arguments: { pipeline_id: pipeline, name: 'Open', kind: 'open', position: 1 }, reason: 'r' })
    expect([refused.status, refused.body.error.code, refused.body.error.message]).toEqual([403, 'insufficient_scope', 'requires pipelines:request_approval'])
  })
  it('associations: lacking read on one endpoint type is the direct call\'s 403, naming the scope', async () => {
    const t = (await post('/api/v1/tasks', { title: 'a' })).id
    const c = (await post('/api/v1/contacts', { name: 'C' })).id
    const body = { a_type: 'tasks', a_id: t, b_type: 'contacts', b_id: c }
    const noContactsRead = await k.actor('no-read', 'agent', ['associations:write', 'tasks:read'])
    const noContactsReadProposer = k.as(noContactsRead, ['associations:request_approval', 'tasks:read'])
    const direct = await k.call(noContactsRead, 'POST', '/api/v1/associations', body)
    const proposal = await k.call(noContactsReadProposer, 'POST', AR, { operation: 'associations.create', arguments: body, reason: 'r' })
    expect(shape(direct).slice(0, 2)).toEqual([403, 'insufficient_scope'])
    expect(direct.body.error.message).toContain('contacts:read')
    expect(shape(proposal)).toEqual(shape(direct))
  })
})
