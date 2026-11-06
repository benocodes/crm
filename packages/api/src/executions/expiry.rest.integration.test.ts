import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openRailKit, type RailKit } from '../test/rail-kit.js'
import type { Actor } from '../test/action-kit.js'

// [[AGT8]] D17, D37, D55: the per-minute expiry sweep. One set unit per tick: the 100 oldest overdue pending requests, each guarded on
// `status = 'pending'`, decided by the `system` principal, one `action_request.expired` each.
let k: RailKit
let owner: Actor
let writer: Actor
let proposer: Actor
const T0 = new Date('2026-11-06T10:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
beforeAll(async () => {
  k = await openRailKit({ now: T0 })
})
afterAll(() => k.close())
beforeEach(async () => {
  k.setNow(T0)
  await k.reset()
  k.setNow(T0)
  owner = k.owner
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write', 'action_requests:read'])
  proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'action_requests:read'])
})
const AR = '/api/v1/action-requests'
/** A pending request expiring `after` seconds from the clock now. */
const pending = async (after: number, title = 't'): Promise<string> => {
  const r = await k.call(proposer, 'POST', AR, { operation: 'tasks.create', arguments: { title }, reason: 'r', expires_at: at((k.now().getTime() - T0.getTime()) / 1000 + after).toISOString() })
  expect(r.status).toBe(201)
  return r.body.id
}
const row = async (id: string) => (await k.rows('action_requests', 'id = ?', id))[0]!
const systemId = async () => ((await k.rows('principals', "kind = 'system'"))[0]?.id as string | undefined) ?? null

describe('the expiry sweep (D55)', () => {
  it('101 overdue requests: 100 expire in one tick, oldest first, each by the system principal with one event', async () => {
    const ids: string[] = []
    for (let i = 0; i < 101; i++) ids.push(await pending(10 + i))
    k.setNow(at(1000))
    expect(await k.expire()).toEqual({ expired: 100 })
    const sys = await systemId()
    expect(sys).not.toBeNull()
    for (const id of ids.slice(0, 100)) expect(await row(id)).toMatchObject({ status: 'expired', decided_by: sys, decided_at: at(1000).toISOString(), updated_at: at(1000).toISOString() })
    expect((await row(ids[100]!)).status).toBe('pending')
    const events = await k.events('action_request.expired')
    expect(events).toHaveLength(100)
    expect(new Set(events.map((e) => e.actor_id))).toEqual(new Set([sys]))
    expect(new Set(events.map((e) => e.resource_id))).toEqual(new Set(ids.slice(0, 100)))
    expect(events[0]).toMatchObject({ before: { status: 'pending' }, after: { status: 'expired', decided_by: sys } })
    // The next tick takes the remainder.
    expect(await k.expire()).toEqual({ expired: 1 })
    expect((await row(ids[100]!)).status).toBe('expired')
    expect(await k.rows('principals', "kind = 'system'")).toHaveLength(1)
  })

  it('leaves a request that is not yet due and every non-pending request untouched', async () => {
    const future = await pending(5000)
    const rejected = await pending(10)
    const withdrawn = await pending(10)
    const executed = await pending(10)
    expect((await k.call(owner, 'POST', `${AR}/${rejected}/reject`)).status).toBe(200)
    expect((await k.call(proposer, 'POST', `${AR}/${withdrawn}/withdraw`)).status).toBe(200)
    expect((await k.call(owner, 'POST', `${AR}/${executed}/approve`)).status).toBe(200)
    const before = await Promise.all([future, rejected, withdrawn, executed].map(row))
    const eventsBefore = (await k.events()).length
    k.setNow(at(1000))
    expect(await k.expire()).toEqual({ expired: 0 })
    expect(await Promise.all([future, rejected, withdrawn, executed].map(row))).toEqual(before)
    expect((await k.events()).length).toBe(eventsBefore)
  })

  it('an empty table is a no-op: no unit, no event, no system principal created', async () => {
    k.setNow(at(1000))
    expect(await k.expire()).toEqual({ expired: 0 })
    expect(await k.events()).toEqual([])
    expect(await k.rows('principals', "kind = 'system'")).toEqual([])
  })

  it('a request withdrawn between plan and commit is not overwritten and gets no expired event', async () => {
    const a = await pending(10)
    const b = await pending(11)
    k.setNow(at(1000))
    k.beforeCommit(async () => {
      expect((await k.call(proposer, 'POST', `${AR}/${a}/withdraw`)).status).toBe(200)
    })
    const r = await k.expire()
    expect(r.expired).toBe(1)
    expect(await row(a)).toMatchObject({ status: 'withdrawn', decided_by: proposer.id })
    expect((await row(b)).status).toBe('expired')
    expect((await k.events('action_request.expired')).map((e) => e.resource_id)).toEqual([b])
  })

  it('a request approved between plan and commit is not overwritten either', async () => {
    const a = await pending(10)
    const b = await pending(11)
    k.setNow(at(1000))
    k.beforeCommit(async () => {
      // Back before its expiry so the approval is allowed, then forward again for the sweep's own commit.
      k.setNow(at(5))
      expect((await k.call(owner, 'POST', `${AR}/${a}/approve`)).status).toBe(200)
      k.setNow(at(1000))
    })
    expect((await k.expire()).expired).toBe(1)
    expect(await row(a)).toMatchObject({ status: 'executed', decided_by: owner.id })
    expect((await row(b)).status).toBe('expired')
    expect((await k.events('action_request.expired')).map((e) => e.resource_id)).toEqual([b])
  })

  it('a pending request holding a dedup_key frees it once expired', async () => {
    const r = await k.call(proposer, 'POST', AR, { operation: 'tasks.create', arguments: { title: 'x' }, reason: 'r', dedup_key: 'dk', expires_at: at(10).toISOString() })
    expect(r.status).toBe(201)
    k.setNow(at(1000))
    await k.expire()
    expect((await k.call(await k.actor('other', 'agent', ['tasks:request_approval']), 'POST', AR, { operation: 'tasks.create', arguments: { title: 'y' }, reason: 'r', dedup_key: 'dk' })).status).toBe(201)
  })
})
