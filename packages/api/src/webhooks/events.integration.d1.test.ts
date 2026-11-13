import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { readStableFeed } from '../events/feed.js'
import { OWNER_SCOPES, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'

// API7 cycle 1 (invariant 5, D5, D19 fail-closed): every write emits exactly one event in its own unit, reads emit none, `webhook.*` events follow D19's owner predicate (flipped by API219), and
// the creation horizon is the subscription's own creation event.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const TASKS = ['tasks:read']
const webhookEvents = () => k.all("select seq, id, type, resource_type, resource_id, actor_id, \"before\", \"after\" from events where type like 'webhook.%' order by seq")
const counts = async () => ({
  subscriptions: (await k.all('select id from webhook_subscriptions')).length,
  secrets: (await k.all('select id from webhook_secrets')).length,
  state: (await k.all('select subscription_id from webhook_dispatch_state')).length,
  events: (await k.all('select id from events')).length,
})
const parse = (s: unknown) => (typeof s === 'string' ? JSON.parse(s) : null)

describe('one event per write, attributed to the caller', () => {
  it('create, update, delete and rotate_secret each emit exactly one event of their type; the owner is the actor', async () => {
    const a = await k.seedAgent(TASKS)
    const made = await k.create(a)
    let events = await webhookEvents()
    expect(events.map((e) => e.type)).toEqual(['webhook.created'])
    await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })
    await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)
    await k.owner('DELETE', `${BASE}/${made.id}`)
    events = await webhookEvents()
    expect(events.map((e) => e.type)).toEqual(['webhook.created', 'webhook.updated', 'webhook.secret_rotated', 'webhook.deleted'])
    for (const e of events) expect([e.resource_type, e.resource_id, e.actor_id]).toEqual(['webhook', made.id, k.e.userId])
  })

  it('an agent caller is the actor of its own writes', async () => {
    await k.grant(k.e.agentId, TASKS)
    const made = (await k.agent('POST', BASE, { url: 'https://example.com/hook', event_types: ['task.created'] })).body
    await k.agent('POST', `${BASE}/${made.id}/rotate-secret`)
    expect((await webhookEvents()).map((e) => [e.type, e.actor_id])).toEqual([['webhook.created', k.e.agentId], ['webhook.secret_rotated', k.e.agentId]])
  })

  it('the records: created has no before and the stored row as after; updated and rotated carry before and after; deleted has no after', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const { secret: _secret, ...record } = made
    await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })
    await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)
    await k.owner('DELETE', `${BASE}/${made.id}`)
    const [created, updated, rotated, deleted] = (await webhookEvents()).map((e) => ({ type: e.type, before: parse(e.before), after: parse(e.after) }))
    expect(created).toMatchObject({ before: null, after: record })
    expect(updated!.before).toMatchObject({ ...record, status: 'active' })
    expect(updated!.after).toMatchObject({ ...record, status: 'paused' })
    expect(rotated!.before).toEqual(rotated!.after)
    expect(rotated!.after).toMatchObject({ id: made.id, status: 'paused' })
    expect(deleted!.before).toMatchObject({ id: made.id })
    expect(deleted!.after).toBeNull()
  })

  it('reads emit none, whether they find the subscription or not', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = (await counts()).events
    await k.owner('GET', BASE)
    await k.owner('GET', `${BASE}/${made.id}`)
    await k.owner('GET', `${BASE}/${uuidv7()}`)
    expect((await counts()).events).toBe(before)
  })

  it('refused writes emit none and write nothing', async () => {
    const a = await k.seedAgent(TASKS)
    const before = await counts()
    await k.owner('POST', BASE, { url: 'http://example.com', agent_id: a })
    await k.owner('POST', BASE, { url: 'https://example.com/hook', agent_id: a, event_types: ['bogus.x'] })
    await k.owner('PATCH', `${BASE}/${uuidv7()}`, { status: 'paused' })
    expect(await counts()).toEqual(before)
  })
})

describe('atomicity: a failing statement leaves nothing of the unit', () => {
  const failing = async (table: string, when: string, run: () => Promise<unknown>) => {
    await k.e.d1!.prepare(`CREATE TRIGGER boom BEFORE INSERT ON ${table} ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`).run()
    try {
      await run()
    } finally {
      await k.e.d1!.prepare('DROP TRIGGER boom').run()
    }
  }

  it('create: a failing dispatch-state row leaves no subscription, secret, state or event', async () => {
    const a = await k.seedAgent(TASKS)
    const before = await counts()
    await failing('webhook_dispatch_state', '', async () => {
      const r = await k.owner('POST', BASE, { url: 'https://example.com/hook', agent_id: a, event_types: ['task.created'] })
      expect(r.status).toBeGreaterThanOrEqual(500)
    })
    expect(await counts()).toEqual(before)
  })

  it('create: a failing event leaves no subscription, secret or state row', async () => {
    const a = await k.seedAgent(TASKS)
    const before = await counts()
    await failing('events', "WHEN NEW.type = 'webhook.created'", async () => {
      expect((await k.owner('POST', BASE, { url: 'https://example.com/hook', agent_id: a, event_types: ['task.created'] })).status).toBeGreaterThanOrEqual(500)
    })
    expect(await counts()).toEqual(before)
  })

  it('rotate_secret: a failing event leaves no new secret row', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = await counts()
    await failing('events', "WHEN NEW.type = 'webhook.secret_rotated'", async () => {
      expect((await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)).status).toBeGreaterThanOrEqual(500)
    })
    expect(await counts()).toEqual(before)
  })

  it('update and delete: a failing event leaves the row as it was', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = await k.all('select * from webhook_subscriptions')
    await failing('events', "WHEN NEW.type = 'webhook.updated'", async () => {
      expect((await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })).status).toBeGreaterThanOrEqual(500)
    })
    await failing('events', "WHEN NEW.type = 'webhook.deleted'", async () => {
      expect((await k.owner('DELETE', `${BASE}/${made.id}`)).status).toBeGreaterThanOrEqual(500)
    })
    expect(await k.all('select * from webhook_subscriptions')).toEqual(before)
  })
})

describe('webhook events in the feed (D19: flipped from the cycle 1 fail-closed rule)', () => {
  it('an owner holding webhooks:read sees them in list, type filter and get; an agent that owns none, or lacks webhooks:read, sees none', async () => {
    const a = await k.seedAgent(TASKS)
    const made = await k.create(a)
    await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })
    const raw = await webhookEvents()
    expect(raw).toHaveLength(2)
    await k.e.d1!.prepare("INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) VALUES (?, ?, ?, 'task.created', 'task', ?, ?)").bind(uuidv7(), '2026-11-12T09:00:00.000Z', k.e.organizationId, uuidv7(), k.e.userId).run()
    const owner = { as: 'user' as const, scopes: OWNER_SCOPES }
    const list = await k.call(owner, 'GET', '/api/v1/events?limit=200')
    expect(list.status, list.text).toBe(200)
    expect(list.body.data.map((e: any) => e.type)).toEqual(['webhook.created', 'webhook.updated', 'task.created'])
    expect((await k.call(owner, 'GET', '/api/v1/events?type=webhook.created')).body.data).toHaveLength(1)
    for (const e of raw) expect((await k.call(owner, 'GET', `/api/v1/events/${e.id}`)).status).toBe(200)
    // The seeded agent owns no subscription (webhooks:read or not), and without webhooks:read nobody but an owner sees any.
    for (const scopes of [['webhooks:read', 'events:read', 'tasks:read'], ['events:read', 'tasks:read']]) {
      const who = { as: 'agent' as const, id: k.e.agentId, scopes }
      expect((await k.call(who, 'GET', '/api/v1/events?limit=200')).body.data.map((e: any) => e.type)).toEqual(['task.created'])
      expect((await k.call(who, 'GET', '/api/v1/events?type=webhook.created')).body.data).toEqual([])
      for (const e of raw) expect((await k.call(who, 'GET', `/api/v1/events/${e.id}`)).status).toBe(404)
    }
  })

  it('the registry declares webhook under the webhooks scope with an owner predicate on agent_id, no longer invisible', () => {
    expect(k.registry.eventTypes().get('webhook')).toEqual({ scope: 'webhooks', owner: { path: '$.agent_id' } })
  })
})

describe('the creation horizon (D5)', () => {
  const rawEvent = async (type: string) => {
    const id = uuidv7()
    await k.e.d1!.prepare("INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) VALUES (?, ?, ?, ?, 'task', ?, ?)").bind(id, '2026-11-12T09:00:00.000Z', k.e.organizationId, type, uuidv7(), k.e.userId).run()
    return id
  }
  const seqOf = async (id: string) => ((await k.all('select seq from events where id = ?', id))[0] as { seq: number }).seq
  const cursorOf = async (subscriptionId: string) => ((await k.all('select cursor_event_id from webhook_dispatch_state where subscription_id = ?', subscriptionId))[0] as { cursor_event_id: string }).cursor_event_id
  const feedAfter = async (cursor: string) => {
    const feed = (await k.e.run(readStableFeed({ readable: ['task', 'webhook'], after: cursor, limit: 100 }))).value
    if (feed.status !== 'ok') throw new Error('unknown cursor')
    return feed.events.map((e) => e.id)
  }

  it('an event committed before creation is at or before the cursor; one committed after is strictly after it', async () => {
    const early = await rawEvent('task.created')
    const made = await k.create(await k.seedAgent(TASKS))
    const late = await rawEvent('task.updated')
    const cursor = await cursorOf(made.id)
    expect(await seqOf(early)).toBeLessThanOrEqual(await seqOf(cursor))
    expect(await seqOf(late)).toBeGreaterThan(await seqOf(cursor))
    expect(await feedAfter(cursor)).toEqual([late])
  })

  it("the cursor is the subscription's own webhook.created event, even with an empty feed (never null)", async () => {
    expect(await k.all('select id from events where type like \'task.%\'')).toEqual([])
    const made = await k.create(await k.seedAgent(TASKS))
    const own = (await k.all("select id from events where type = 'webhook.created' and resource_id = ?", made.id)) as { id: string }[]
    expect(own).toHaveLength(1)
    const cursor = await cursorOf(made.id)
    expect(cursor).toBe(own[0]!.id)
    expect(await feedAfter(cursor)).toEqual([])
    expect(await k.all('select last_dispatched_at, last_success_at from webhook_dispatch_state where subscription_id = ?', made.id)).toEqual([{ last_dispatched_at: null, last_success_at: null }])
  })

  it('a second subscription gets its own horizon: the newest event at its creation, which is its own', async () => {
    const a = await k.seedAgent(TASKS)
    const first = await k.create(a)
    const mid = await rawEvent('task.created')
    const second = await k.create(a)
    expect(await cursorOf(second.id)).not.toBe(await cursorOf(first.id))
    expect(await feedAfter(await cursorOf(first.id))).toEqual([mid, ...(await k.all("select id from events where type = 'webhook.created' and resource_id = ?", second.id)).map((r: any) => r.id)])
    expect(await feedAfter(await cursorOf(second.id))).toEqual([])
  })
})
