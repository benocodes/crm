import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPES, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'

// API219 (D19): `webhook.*` events are shown under `webhooks:read`, and to an agent only for its own subscriptions (the record's `agent_id`, `before` for a delete); a user holding
// the scope sees all. The same rule serves events.list, events.get, the create/update type checks and dispatch.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const SCOPES = ['webhooks:read', 'webhooks:write', 'events:read', 'tasks:read']
const asAgent = (id: string) => ({ as: 'agent' as const, id, scopes: SCOPES })
const types = (r: { body: { data: { type: string }[] } }) => r.body.data.map((e) => e.type)

/** Two agents, a subscription each, and the four webhook event types made on each (create, update, rotate, delete). */
async function twoAgents() {
  const a = await k.seedAgent(SCOPES)
  const b = await k.seedAgent(SCOPES)
  const subA = await k.create(a)
  const subB = await k.create(b)
  for (const [who, sub] of [[a, subA], [b, subB]] as const) {
    expect((await k.call(asAgent(who), 'PATCH', `${BASE}/${sub.id}`, { status: 'paused' })).status).toBe(200)
    expect((await k.call(asAgent(who), 'POST', `${BASE}/${sub.id}/rotate-secret`)).status).toBe(200)
    expect((await k.call(asAgent(who), 'DELETE', `${BASE}/${sub.id}`)).status).toBe(204)
  }
  const raw = (id: string) => k.all("select id, type from events where resource_type = 'webhook' and resource_id = ? order by seq", id) as Promise<{ id: string; type: string }[]>
  return { a, b, subA, subB, eventsA: await raw(subA.id), eventsB: await raw(subB.id) }
}

describe('the owner predicate in events.list and events.get', () => {
  it("each agent sees its own subscription's created, updated, secret_rotated and deleted events (the delete through before), never the other's", async () => {
    const { a, b, eventsA, eventsB } = await twoAgents()
    expect(eventsA.map((e) => e.type)).toEqual(['webhook.created', 'webhook.updated', 'webhook.secret_rotated', 'webhook.deleted'])
    for (const [me, mine, theirs] of [[a, eventsA, eventsB], [b, eventsB, eventsA]] as const) {
      const list = await k.call(asAgent(me), 'GET', '/api/v1/events?limit=200')
      expect(list.status, list.text).toBe(200)
      expect(list.body.data.map((e: any) => e.id)).toEqual(mine.map((e) => e.id))
      expect(types(list)).toEqual(['webhook.created', 'webhook.updated', 'webhook.secret_rotated', 'webhook.deleted'])
      for (const e of mine) expect((await k.call(asAgent(me), 'GET', `/api/v1/events/${e.id}`)).status).toBe(200)
      for (const e of theirs) expect((await k.call(asAgent(me), 'GET', `/api/v1/events/${e.id}`)).status, "another agent's webhook event is 404").toBe(404)
      const filtered = await k.call(asAgent(me), 'GET', '/api/v1/events?type=webhook.deleted')
      expect(filtered.body.data.map((e: any) => e.id)).toEqual([mine[3]!.id])
    }
  })

  it('the delete is shown through the record of before (its after is null)', async () => {
    const { a, eventsA } = await twoAgents()
    const deleted = (await k.call(asAgent(a), 'GET', `/api/v1/events/${eventsA[3]!.id}`)).body
    expect(deleted.after).toBeNull()
    expect(deleted.before.agent_id).toBe(a)
  })

  it('an owner (a user holding webhooks:read) sees every webhook event', async () => {
    const { eventsA, eventsB } = await twoAgents()
    const list = await k.call({ as: 'user', scopes: OWNER_SCOPES }, 'GET', '/api/v1/events?limit=200')
    expect(list.body.data.filter((e: any) => e.resource_type === 'webhook').map((e: any) => e.id).sort()).toEqual([...eventsA, ...eventsB].map((e) => e.id).sort())
  })

  it('an agent without webhooks:read sees none of its own', async () => {
    const { a, eventsA } = await twoAgents()
    const who = { as: 'agent' as const, id: a, scopes: ['events:read', 'tasks:read'] }
    expect(types(await k.call(who, 'GET', '/api/v1/events?limit=200'))).toEqual([])
    for (const e of eventsA) expect((await k.call(who, 'GET', `/api/v1/events/${e.id}`)).status).toBe(404)
  })
})

describe('subscribing to webhook.* and dispatch', () => {
  it('an agent holding webhooks:read may subscribe to webhook.updated (and is refused action_request.created, still invisible, #217)', async () => {
    const a = await k.seedAgent(SCOPES)
    expect((await k.owner('POST', BASE, { url: 'https://example.com/h', agent_id: a, event_types: ['webhook.updated'] })).status).toBe(201)
    const refused = await k.owner('POST', BASE, { url: 'https://example.com/h', agent_id: a, event_types: ['action_request.created'] })
    expect([refused.status, refused.body.error?.code ?? refused.body.code]).toEqual([400, 'event_type_not_readable'])
    const bare = await k.seedAgent(['events:read', 'tasks:read'])
    const none = await k.owner('POST', BASE, { url: 'https://example.com/h', agent_id: bare, event_types: ['webhook.updated'] })
    expect([none.status, none.body.error?.code ?? none.body.code]).toEqual([400, 'event_type_not_readable'])
  })

  it('an agent subscribed to webhook.updated is dispatched only its own subscription events', async () => {
    const a = await k.seedAgent(SCOPES)
    const b = await k.seedAgent(SCOPES)
    const own = await k.create(a, { event_types: ['webhook.updated'] })
    const theirs = await k.create(b, { event_types: ['task.created'] })
    expect((await k.call(asAgent(b), 'PATCH', `${BASE}/${theirs.id}`, { url: 'https://example.com/b2' })).status).toBe(200)
    expect((await k.call(asAgent(a), 'PATCH', `${BASE}/${own.id}`, { url: 'https://example.com/a2' })).status).toBe(200)
    const mine = (await k.all("select id from events where type = 'webhook.updated' and resource_id = ?", own.id)) as { id: string }[]
    await k.dispatch()
    expect((await k.deliveries(own.id)).map((r) => r.event_id)).toEqual(mine.map((e) => e.id))
    expect(await k.deliveries(theirs.id), 'b subscribed to task.created only').toEqual([])
  })
})
