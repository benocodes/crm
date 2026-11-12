import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { URL_OK, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'

// API7 cycle 1 (D3, D16, D18; update and delete semantics): every refusal with its trigger, the default stored resolved, the limit, the status rules.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const TASKS = ['tasks:read']
const rows = () => k.all('select * from webhook_subscriptions order by id')
const refused = (r: { status: number; body: any }, status: number, code: string) => expect([r.status, r.body?.error?.code]).toEqual([status, code])
const post = (agent: string, over: Record<string, unknown> = {}) => k.owner('POST', BASE, { url: URL_OK, agent_id: agent, ...over })

describe('event types at create (D3)', () => {
  it('a pattern violation, none and 21 types: 400 validation_error and nothing written; 20 is accepted', async () => {
    const a = await k.seedAgent(TASKS)
    for (const bad of ['Task.created', 'task', 'task.created.extra', '1task.created', 'task.', '.created', 'task created', 'task.Created', '*']) {
      refused(await post(a, { event_types: [bad] }), 400, 'validation_error')
    }
    refused(await post(a, { event_types: [] }), 400, 'validation_error')
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('')
    refused(await post(a, { event_types: letters.slice(0, 21).map((c) => `task.${c}`) }), 400, 'validation_error')
    expect(await rows()).toEqual([])
    const twenty = await post(a, { event_types: letters.slice(0, 20).map((c) => `task.${c}`) })
    expect([twenty.status, twenty.body.event_types.length]).toEqual([201, 20])
  })

  it('a resource type the registry does not know: 400 unknown_event_type', async () => {
    const a = await k.seedAgent(TASKS)
    refused(await post(a, { event_types: ['bogus.created'] }), 400, 'unknown_event_type')
    refused(await post(a, { event_types: ['task.created', 'nothing.happened'] }), 400, 'unknown_event_type')
    expect(await rows()).toEqual([])
  })

  it('a type the agent cannot see: 400 event_type_not_readable, for an invisible type and for a scope the agent lacks', async () => {
    const a = await k.seedAgent(TASKS)
    refused(await post(a, { event_types: ['action_request.created'] }), 400, 'event_type_not_readable')
    refused(await post(a, { event_types: ['action_execution.created'] }), 400, 'event_type_not_readable')
    refused(await post(a, { event_types: ['webhook.created'] }), 400, 'event_type_not_readable')
    refused(await post(a, { event_types: ['note.created'] }), 400, 'event_type_not_readable')
    refused(await post(a, { event_types: ['task.created', 'note.created'] }), 400, 'event_type_not_readable')
    expect(await rows()).toEqual([])
    expect((await post(a, { event_types: ['task.created', 'task.updated'] })).status).toBe(201)
  })

  it("is judged by the AGENT's visibility, not the caller's: an owner holding interactions:read naming an agent without it is refused", async () => {
    const lacking = await k.seedAgent(TASKS)
    const holding = await k.seedAgent([...TASKS, 'interactions:read'])
    refused(await post(lacking, { event_types: ['interaction.created'] }), 400, 'event_type_not_readable')
    expect((await post(holding, { event_types: ['interaction.created'] })).status).toBe(201)
  })

  it('duplicates in one list are stored once, in order', async () => {
    const a = await k.seedAgent(TASKS)
    const r = await post(a, { event_types: ['task.updated', 'task.created', 'task.updated'] })
    expect(r.body.event_types).toEqual(['task.updated', 'task.created'])
  })
})

describe('the default list (D18)', () => {
  it('omitted event_types default to ["interaction.created"], stored resolved and returned by get', async () => {
    const a = await k.seedAgent(['interactions:read'])
    const made = await post(a)
    expect([made.status, made.body.event_types]).toEqual([201, ['interaction.created']])
    expect((await rows())[0]!.event_types).toBe('["interaction.created"]')
    expect((await k.owner('GET', `${BASE}/${made.body.id}`)).body.event_types).toEqual(['interaction.created'])
  })

  it('an agent without interactions:read gets 400 event_type_not_readable on the default, and nothing is written', async () => {
    const a = await k.seedAgent(TASKS)
    refused(await post(a), 400, 'event_type_not_readable')
    expect(await rows()).toEqual([])
  })
})

describe('update (D3, D18)', () => {
  it('re-validates the types like create, has no default, and leaves them alone when omitted', async () => {
    const a = await k.seedAgent(TASKS)
    const made = await k.create(a)
    const path = `${BASE}/${made.id}`
    refused(await k.owner('PATCH', path, { event_types: ['bogus.created'] }), 400, 'unknown_event_type')
    refused(await k.owner('PATCH', path, { event_types: ['action_request.created'] }), 400, 'event_type_not_readable')
    refused(await k.owner('PATCH', path, { event_types: ['note.created'] }), 400, 'event_type_not_readable')
    refused(await k.owner('PATCH', path, { event_types: [] }), 400, 'validation_error')
    refused(await k.owner('PATCH', path, { event_types: ['Task.created'] }), 400, 'validation_error')
    expect((await k.owner('GET', path)).body.event_types).toEqual(['task.created'])
    const changed = await k.owner('PATCH', path, { event_types: ['task.updated'] })
    expect([changed.status, changed.body.event_types]).toEqual([200, ['task.updated']])
    const url = await k.owner('PATCH', path, { url: 'https://example.org/other' })
    expect([url.body.event_types, url.body.url]).toEqual([['task.updated'], 'https://example.org/other'])
  })

  it("judges a changed list against the agent's stored grants at the time of the update", async () => {
    const a = await k.seedAgent(TASKS)
    const made = await k.create(a)
    await k.grant(a, [])
    refused(await k.owner('PATCH', `${BASE}/${made.id}`, { event_types: ['task.updated'] }), 400, 'event_type_not_readable')
  })

  it('refuses a bad url with invalid_url and an unknown field with validation_error', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    refused(await k.owner('PATCH', `${BASE}/${made.id}`, { url: 'http://example.com/hook' }), 400, 'invalid_url')
    refused(await k.owner('PATCH', `${BASE}/${made.id}`, { agent_id: k.e.agentId }), 400, 'validation_error')
  })

  it('status: disabled from a caller is 400 validation_error; paused works; active re-enables a disabled row', async () => {
    const a = await k.seedAgent(TASKS)
    const made = await k.create(a)
    const path = `${BASE}/${made.id}`
    refused(await k.owner('PATCH', path, { status: 'disabled' }), 400, 'validation_error')
    expect((await k.owner('GET', path)).body.status).toBe('active')
    expect((await k.owner('PATCH', path, { status: 'paused' })).body.status).toBe('paused')
    await k.e.d1!.prepare("UPDATE webhook_subscriptions SET status = 'disabled' WHERE id = ?").bind(made.id).run()
    expect((await k.owner('GET', path)).body.status).toBe('disabled')
    expect((await k.owner('PATCH', path, { status: 'active' })).body.status).toBe('active')
  })

  it('an empty patch changes nothing and emits no event; an unknown id is 404', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = await k.all("select count(*) as n from events where type = 'webhook.updated'")
    const r = await k.owner('PATCH', `${BASE}/${made.id}`, {})
    expect([r.status, r.body.id]).toEqual([200, made.id])
    expect(await k.all("select count(*) as n from events where type = 'webhook.updated'")).toEqual(before)
    refused(await k.owner('PATCH', `${BASE}/0190b2c4-0000-7000-8000-00000000dead`, { status: 'paused' }), 404, 'not_found')
  })
})

describe('delete (soft)', () => {
  it('sets deleted_at and keeps the row; then get, update, rotate and delete are 404 and the list omits it', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const path = `${BASE}/${made.id}`
    expect((await k.owner('DELETE', path)).status).toBe(204)
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.deleted_at).not.toBeNull()
    for (const [method, p] of [['GET', path], ['PATCH', path], ['DELETE', path], ['POST', `${path}/rotate-secret`]] as const) {
      refused(await k.owner(method, p, method === 'PATCH' ? { status: 'paused' } : undefined), 404, 'not_found')
    }
    expect((await k.owner('GET', BASE)).body.data).toEqual([])
  })
})

describe('the limit (D16)', () => {
  it('an agent with no subscription creates one; at 10 live the eleventh is 409 webhook_limit; the limit is per agent', async () => {
    const a = await k.seedAgent(TASKS)
    const b = await k.seedAgent(TASKS)
    expect(await rows()).toEqual([])
    for (let i = 0; i < 10; i++) await k.create(a)
    refused(await post(a, { event_types: ['task.created'] }), 409, 'webhook_limit')
    expect(await rows()).toHaveLength(10)
    expect((await post(b, { event_types: ['task.created'] })).status).toBe(201)
  })

  it('a soft-deleted subscription frees its slot; one paused or disabled still counts', async () => {
    const a = await k.seedAgent(TASKS)
    const made = []
    for (let i = 0; i < 10; i++) made.push(await k.create(a))
    await k.owner('PATCH', `${BASE}/${made[0].id}`, { status: 'paused' })
    refused(await post(a, { event_types: ['task.created'] }), 409, 'webhook_limit')
    expect((await k.owner('DELETE', `${BASE}/${made[1].id}`)).status).toBe(204)
    expect((await post(a, { event_types: ['task.created'] })).status).toBe(201)
    refused(await post(a, { event_types: ['task.created'] }), 409, 'webhook_limit')
  })

  it('a create that loses a race for the last slot between plan and commit is refused, never stored as an eleventh', async () => {
    const a = await k.seedAgent(TASKS)
    for (let i = 0; i < 9; i++) await k.create(a)
    k.e.betweenPlanAndCommit(async () => {
      const at = '2026-11-12T09:00:00.000Z'
      await k
        .e.d1!.prepare("INSERT INTO webhook_subscriptions (id, created_at, updated_at, organization_id, created_by, agent_id, url, event_types, status) VALUES (?, ?, ?, ?, ?, ?, ?, '[\"task.created\"]', 'active')")
        .bind('0190b2c4-0000-7000-8000-0000000000aa', at, at, k.e.organizationId, k.e.userId, a, URL_OK)
        .run()
    })
    const r = await post(a, { event_types: ['task.created'] })
    refused(r, 409, 'webhook_limit')
    expect(await rows()).toHaveLength(10)
  })
})
