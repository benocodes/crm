import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'
import { checkEventTypes } from '../webhooks/operations.js'

// CORE347 group 4 (P2): the per-type `owner` record predicate ([[API219]] D19) stays as a mechanism with no production caller, proven through a test-only event type.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
  k.registry.registerEventType('widget', { scope: 'tasks', owner: { path: '$.agent_id' } })
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const SCOPES = ['events:read', 'tasks:read']

it('an agent sees only rows whose record path equals its id (before for a delete); a user with the scope sees all; checkEventTypes accepts the type for the agent', async () => {
  const a = await k.seedAgent(SCOPES)
  const b = await k.seedAgent(SCOPES)
  const mk = (type: string, agent: string, del = false) =>
    k.rawEvent(type, {
      resourceType: 'widget',
      before: del ? { agent_id: agent } : undefined,
      after: del ? null : { agent_id: agent },
    })
  const mine = [await mk('widget.created', a), await mk('widget.deleted', a, true)]
  const theirs = [await mk('widget.created', b), await mk('widget.deleted', b, true)]
  const as = (id: string) => ({ as: 'agent' as const, id, scopes: SCOPES })
  const list = await k.call(as(a), 'GET', '/api/v1/events?limit=200')
  expect(list.body.data.map((e: any) => e.id)).toEqual(mine)
  for (const id of theirs) expect((await k.call(as(a), 'GET', `/api/v1/events/${id}`)).status).toBe(404)
  const all = await k.call({ as: 'user', scopes: SCOPES }, 'GET', '/api/v1/events?limit=200')
  expect(all.body.data.map((e: any) => e.id)).toEqual([...mine, ...theirs])
  expect(() => checkEventTypes(k.registry, { id: a, scopes: SCOPES }, ['widget.created'])).not.toThrow()
})

it('no production registration declares owner', () => {
  const real = createVibaseRegistry()
  for (const [type, decl] of real.eventTypes()) expect('owner' in decl, type).toBe(false)
})
