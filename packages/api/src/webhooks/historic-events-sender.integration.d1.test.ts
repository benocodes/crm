import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openSenderKit, type SenderKit } from '../test/sender-kit.js'

// CORE347 group 3 (P3): a delivery already pending for a historic `webhook.*` event is cancelled `cancelled_scope` at send time, and nothing is fetched.
let s: SenderKit
beforeAll(async () => {
  s = await openSenderKit()
})
afterAll(() => s.close())
beforeEach(() => s.reset())

it('a pending delivery for a historic webhook.* event is cancelled_scope with no outbound fetch', async () => {
  // The agent holds webhooks:read, so only the type's registration decides whether it can still see the event.
  const { agent, sub } = await s.subscribe({ scopes: ['events:read', 'tasks:read', 'webhooks:read'] })
  const { delivery } = await s.due(sub.id)
  const historic = await s.k.rawEvent('webhook.created', {
    resourceType: 'webhook',
    resourceId: sub.id,
    after: { id: sub.id, agent_id: agent },
  })
  await s.k.control.prepare('UPDATE webhook_deliveries SET event_id = ? WHERE id = ?').bind(historic, delivery).run()
  const summary = await s.send()
  expect(s.calls).toHaveLength(0)
  expect(summary.cancelled).toBe(1)
  expect(await s.row(delivery)).toMatchObject({ status: 'cancelled', last_error: 'cancelled_scope' })
})
