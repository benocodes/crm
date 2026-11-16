import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OWNER_SCOPES, openWebhookKit, type Who, type WebhookKit } from '../test/webhook-kit.js'

// CORE357 groups 1 and 2 (P1): the `api_key` event type left the event-type map, so historic `api_key.*` rows (nothing has written them since [[CORE351]]) are invisible to every reader on every read path, and `api_key.*` cannot be subscribed to.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const SCOPES = ['webhooks:read', 'webhooks:write', 'events:read', 'tasks:read']
const KEY_SCOPES = ['agents:read', 'events:read', 'tasks:read']

describe('historic api_key.* rows are invisible (fail closed)', () => {
  it('no reader sees them through events.list (unfiltered and by type) or events.get; other events stay, in order', async () => {
    const a = await k.seedAgent(KEY_SCOPES)
    const keyId = '019a0000-0000-7000-8000-000000000001'
    const record = { id: keyId, agent_id: a, prefix: 'abcdefghijk' }
    const historic: { id: string; type: string }[] = []
    const other: string[] = []
    for (const [type, before, after] of [
      ['api_key.created', undefined, record],
      ['api_key.revoked', record, { ...record, revoked_at: '2026-11-12T09:00:00.000Z' }],
    ] as const) {
      historic.push({ id: await k.rawEvent(type, { resourceType: 'api_key', resourceId: keyId, before, after }), type })
      other.push(await k.task(`between ${type}`))
    }
    const readers: (readonly [string, Who])[] = [
      ['an agent holding agents:read and events:read', { as: 'agent', id: a, scopes: KEY_SCOPES }],
      ['the owner', { as: 'user', scopes: [...OWNER_SCOPES, 'agents:read', 'tasks:read'] }],
    ]
    for (const [name, who] of readers) {
      const list = await k.call(who, 'GET', '/api/v1/events?limit=200')
      expect(list.status, `${name}: ${list.text}`).toBe(200)
      expect(
        list.body.data.map((e: any) => e.id),
        name,
      ).toEqual(other)
      for (const t of ['api_key.created', 'api_key.revoked']) {
        const filtered = await k.call(who, 'GET', `/api/v1/events?type=${t}`)
        expect(filtered.body.data, `${name} ${t}`).toEqual([])
      }
      for (const e of historic)
        expect((await k.call(who, 'GET', `/api/v1/events/${e.id}`)).status, `${name} get ${e.type}`).toBe(404)
    }
  })
})

describe('api_key.* cannot be subscribed to', () => {
  const refused = (r: { status: number; body: any }) =>
    expect([r.status, r.body.error?.code ?? r.body.code]).toEqual([400, 'unknown_event_type'])

  it('create and update naming an api_key.* type are 400 unknown_event_type and write nothing in control', async () => {
    const a = await k.seedAgent(SCOPES)
    const sub = await k.create(a)
    const audit = () => k.all('select id from control_audit order by id')
    const rows = () => k.all('select * from webhook_subscriptions order by id')
    const before = { audit: await audit(), rows: await rows() }
    refused(
      await k.owner('POST', BASE, { url: 'https://example.com/h', agent_id: a, event_types: ['api_key.created'] }),
    )
    refused(
      await k.owner('POST', BASE, {
        url: 'https://example.com/h',
        agent_id: a,
        event_types: ['task.created', 'api_key.revoked'],
      }),
    )
    refused(await k.owner('PATCH', `${BASE}/${sub.id}`, { event_types: ['api_key.created'] }))
    refused(await k.owner('PATCH', `${BASE}/${sub.id}`, { event_types: ['task.created', 'api_key.revoked'] }))
    expect({ audit: await audit(), rows: await rows() }).toEqual(before)
  })
})
