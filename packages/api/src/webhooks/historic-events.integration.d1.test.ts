import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPES, openWebhookKit, type Who, type WebhookKit } from '../test/webhook-kit.js'

// CORE347 groups 1 and 2 (P1, P3): the `webhook` event type left the event-type map, so the four historic `webhook.*` rows ([[CORE337]] stopped writing them) are invisible to every reader on every read
// path, and `webhook.*` cannot be subscribed to. A subscription stored with one (accepted between #337 and #347) is read back as stored and never fires.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const SCOPES = ['webhooks:read', 'webhooks:write', 'events:read', 'tasks:read']
const asAgent = (id: string) => ({ as: 'agent' as const, id, scopes: SCOPES })
const refused = (r: { status: number; body: any }, status: number, code: string) =>
  expect([r.status, r.body.error?.code ?? r.body.code]).toEqual([status, code])

/** The four historic rows of one agent's subscription, written raw as the operations wrote them before the switch, with a `task.created` between each. */
async function history(agent: string) {
  const sub = await k.create(agent)
  const record = { id: sub.id, agent_id: agent, status: 'active' }
  const out: { id: string; type: string }[] = []
  const other: string[] = []
  for (const [type, before, after] of [
    ['webhook.created', undefined, record],
    ['webhook.updated', record, { ...record, status: 'paused' }],
    ['webhook.secret_rotated', record, record],
    ['webhook.deleted', record, null],
  ] as const) {
    out.push({
      id: await k.rawEvent(type, { resourceType: 'webhook', resourceId: sub.id, before, after }),
      type,
    })
    other.push(await k.task(`between ${type}`))
  }
  return { sub, historic: out, other }
}

describe('historic webhook.* rows are invisible (fail closed)', () => {
  it('no reader sees them through events.list (unfiltered and by type) or events.get; other events stay, in order', async () => {
    const a = await k.seedAgent(SCOPES)
    const b = await k.seedAgent(SCOPES)
    const { historic, other } = await history(a)
    const readers: (readonly [string, Who])[] = [
      ['the owning agent', asAgent(a)],
      ['another agent', asAgent(b)],
      ['a user with webhooks:read and events:read', { as: 'user', scopes: [...OWNER_SCOPES, 'tasks:read'] }],
    ]
    for (const [name, who] of readers) {
      const list = await k.call(who, 'GET', '/api/v1/events?limit=200')
      expect(list.status, `${name}: ${list.text}`).toBe(200)
      expect(
        list.body.data.map((e: any) => e.id),
        name,
      ).toEqual(other)
      for (const t of ['webhook.created', 'webhook.deleted']) {
        const filtered = await k.call(who, 'GET', `/api/v1/events?type=${t}`)
        expect(filtered.body.data, `${name} ${t}`).toEqual([])
      }
      for (const e of historic)
        expect((await k.call(who, 'GET', `/api/v1/events/${e.id}`)).status, `${name} get ${e.type}`).toBe(404)
    }
  })
})

describe('webhook.* cannot be subscribed to', () => {
  it('create and update naming a webhook.* type are 400 unknown_event_type and write nothing in control', async () => {
    const a = await k.seedAgent(SCOPES)
    const sub = await k.create(a)
    const audit = () => k.all('select id from control_audit order by id')
    const rows = () => k.all('select * from webhook_subscriptions order by id')
    const before = { audit: await audit(), rows: await rows() }
    for (const type of ['webhook.created', 'webhook.updated', 'webhook.deleted', 'webhook.secret_rotated']) {
      refused(
        await k.owner('POST', BASE, { url: 'https://example.com/h', agent_id: a, event_types: [type] }),
        400,
        'unknown_event_type',
      )
      refused(
        await k.owner('PATCH', `${BASE}/${sub.id}`, { event_types: ['task.created', type] }),
        400,
        'unknown_event_type',
      )
    }
    expect({ audit: await audit(), rows: await rows() }).toEqual(before)
  })

  it('a stored subscription naming webhook.updated lists as stored and accepts an update without event_types', async () => {
    const a = await k.seedAgent(SCOPES)
    const sub = await k.create(a)
    await k.control
      .prepare('UPDATE webhook_subscriptions SET event_types = ? WHERE id = ?')
      .bind(JSON.stringify(['webhook.updated']), sub.id)
      .run()
    const list = await k.owner('GET', BASE)
    expect(list.body.data.find((s: any) => s.id === sub.id).event_types).toEqual(['webhook.updated'])
    const patched = await k.owner('PATCH', `${BASE}/${sub.id}`, { url: 'https://example.com/new' })
    expect([patched.status, patched.body.event_types]).toEqual([200, ['webhook.updated']])
  })
})

describe('dispatch ignores historic rows (group 3)', () => {
  it('a subscription storing webhook.updated, positioned before the historic rows, gets no delivery', async () => {
    const a = await k.seedAgent(SCOPES)
    const sub = await k.create(a)
    await k.control
      .prepare('UPDATE webhook_subscriptions SET event_types = ? WHERE id = ?')
      .bind(JSON.stringify(['webhook.updated']), sub.id)
      .run()
    await k.dispatch()
    await history(a)
    await k.dispatch()
    expect(await k.deliveries(sub.id)).toEqual([])
  })
})
