import { expect } from 'vitest'
import type { Harness } from './backend.js'
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export async function exactEvents(h: Harness, execution: any, expected: any[]) {
  const events = await h.events()
  expect(events).toHaveLength(expected.length)
  expect(execution.eventOrder).toHaveLength(expected.length)
  for (const [i, e] of execution.eventOrder.entries()) {
    expect(e.id).toMatch(uuidPattern)
    expect(e.ordinal).toBe(i)
    expect(events.find((r) => r.id === e.id)).toMatchObject({
      ...expected[i],
      actor_id: h.a.actor.id,
      organization_id: h.a.organizationId,
    })
  }
  const counts = await h.counts()
  expect(counts[h.backend === 'postgres' ? 'storage_prototype.operations' : 'prototype_operations']).toBe(0)
  expect(counts[h.backend === 'postgres' ? 'storage_prototype.rows' : 'prototype_rows']).toBe(0)
}
