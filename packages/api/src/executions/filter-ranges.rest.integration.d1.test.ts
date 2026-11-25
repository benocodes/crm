import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openRailKit, type RailKit } from '../test/rail-kit.js'
import type { Actor } from '../test/action-kit.js'

// [[CORE602]] D1: `action_executions.list` takes ranges on its column filters, ANDed with its other filters and with the operation-based visibility.
let k: RailKit
let writer: Actor
let reader: Actor
const T0 = Date.parse('2026-11-06T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000)
const iso = (s: number) => at(s).toISOString()
const seeded: Record<string, string> = {}
beforeAll(async () => {
  k = await openRailKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write'])
  reader = await k.actor('reader', 'agent', ['tasks:read'])
  const enqueue = async (name: string, s: number) => {
    k.setNow(at(s))
    seeded[name] = (await k.enqueue(writer, { text: name, idempotency_key: name }, 'reconcile')).body.id
  }
  // A, B at 0; C at 1; D at 2; E at 3 (the upper bound)
  await enqueue('A', 0)
  await enqueue('B', 0)
  await enqueue('C', 1)
  await enqueue('D', 2)
  await enqueue('E', 3)
  k.setNow(at(10))
  await k.run(seeded.C!)
})
const idsOf = async (query: string) => {
  const r = await k.call(reader, 'GET', `/api/v1/action-executions?${query}`)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return (r.body.data as Array<{ id: string }>).map((x) => x.id).sort()
}
const named = (...n: string[]) => n.map((x) => seeded[x]!).sort()

describe('action_executions.list ranges', () => {
  it('created_at between a lower bound (included) and an upper bound (excluded), either order, ANDed with status', async () => {
    const range = `created_at=gte.${iso(1)}&created_at=lt.${iso(3)}`
    expect(await idsOf(range)).toEqual(named('C', 'D'))
    expect(await idsOf(`created_at=lt.${iso(3)}&created_at=gte.${iso(1)}`)).toEqual(named('C', 'D'))
    const queued = await k.call(reader, 'GET', `/api/v1/action-executions?${range}&status=queued`)
    expect(queued.body.data.map((x: any) => x.id)).toEqual([seeded.D])
  })
})
