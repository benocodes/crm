import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { openSenderKit, type SenderKit } from '../test/sender-kit.js'

// [[CORE680]] D5: the delivered webhook payload of a task event carries `description` and never `notes`.
let s: SenderKit
beforeAll(async () => {
  s = await openSenderKit()
})
afterAll(() => s.close())
beforeEach(() => s.reset())

it('a delivered task event has description in after and no notes key', async () => {
  const { sub } = await s.subscribe()
  await s.due(sub.id)
  expect((await s.send()).sent).toBe(1)
  const payload = JSON.parse(s.calls[0]!.body)
  expect(payload.type).toBe('task.created')
  expect(payload.after).toHaveProperty('description', null)
  expect(payload.after).not.toHaveProperty('notes')
})
