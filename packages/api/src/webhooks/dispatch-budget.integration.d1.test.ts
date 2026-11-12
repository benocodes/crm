import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { StorageBinding } from '@vault/storage'
import { openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'
import { TickBudget } from './budget.js'
import { dispatchWebhooks } from './dispatch.js'

// API7 D24 (API220): dispatch takes a budget view and asks it before each unit (the eligibility read costs 1, a page of one subscription 2: the read and the write). Exhaustion defers, never fails:
// an unserved subscription keeps its cursor and the next tick serves it. With no budget (the dispatch suites) nothing changes.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

/** The kit's dispatch deps with every unit's round trips spent on `b`. */
function metered(b: TickBudget) {
  const base = k.deps().binding
  const binding = { ...base, runtime: { ...base.runtime, execute: async (identity: any, prepared: any) => { const r = await base.runtime.execute(identity, prepared); b.spend(r.stats.roundTrips); return r } } } as StorageBinding
  return { ...k.deps(), binding }
}
async function backlog(subs: number) {
  const agent = await k.seedAgent(['events:read', 'tasks:read'])
  const ids: string[] = []
  for (let i = 0; i < subs; i++) ids.push((await k.create(agent)).id)
  await k.task('backlog')
  return ids
}
const cursors = async (ids: string[]) => Promise.all(ids.map((id) => k.cursorOf(id)))

describe('dispatch and the budget (D24)', () => {
  it('serves the subscriptions the budget can finish, defers the rest with their cursors untouched, spends no more than its share and counts the deferred', async () => {
    const ids = await backlog(6)
    const before = await cursors(ids)
    const total = new TickBudget(100)
    const share = total.slice(5) // 1 for the eligibility read, then 2 a subscription: two subscriptions
    const summary = await dispatchWebhooks({ ...metered(total), budget: share })
    expect(total.used).toBeLessThanOrEqual(5)
    expect(summary).toMatchObject({ subscriptions: 2, events: 2, deferred: 4, failed: 0 })
    const after = await cursors(ids)
    expect(after.filter((c, i) => c !== before[i])).toHaveLength(2)
    expect(after.filter((c, i) => c === before[i])).toHaveLength(4)
    expect(await k.deliveries()).toHaveLength(2)
  })

  it('the next tick serves the deferred: every subscription ends with one row, none twice', async () => {
    const ids = await backlog(6)
    for (let tick = 0; tick < 3; tick++) await dispatchWebhooks({ ...metered(new TickBudget(100)), budget: new TickBudget(5) })
    expect(await k.deliveries()).toHaveLength(6)
    for (const id of ids) expect(await k.deliveries(id)).toHaveLength(1)
  })

  it('a budget that covers everything defers nothing, and no budget is unlimited', async () => {
    await backlog(4)
    const summary = await dispatchWebhooks({ ...k.deps(), budget: { remaining: () => 1000 } })
    expect(summary).toMatchObject({ subscriptions: 4, deferred: 0 })
    await k.reset()
    await backlog(4)
    expect(await dispatchWebhooks(k.deps())).toMatchObject({ subscriptions: 4, deferred: 0 })
  })

  it('a budget of 0 reads nothing and writes nothing', async () => {
    const ids = await backlog(3)
    const before = await cursors(ids)
    const total = new TickBudget(100)
    const summary = await dispatchWebhooks({ ...metered(total), budget: { remaining: () => 0 } })
    expect(total.used).toBe(0)
    expect(summary).toMatchObject({ subscriptions: 0, events: 0, deferred: 0, failed: 0 })
    expect(await cursors(ids)).toEqual(before)
  })

  it('a page not worth starting is deferred too: a subscription with a second page does not take it without budget', async () => {
    const agent = await k.seedAgent(['events:read', 'tasks:read'])
    const sub = await k.create(agent)
    for (let i = 0; i < 101; i++) await k.rawEvent('task.created', { resourceType: 'task', after: { id: String(i) } })
    const total = new TickBudget(100)
    const summary = await dispatchWebhooks({ ...metered(total), budget: total.slice(3) }) // the eligibility read, then one page (2); a second page (2 more) does not fit
    expect(summary).toMatchObject({ subscriptions: 1, events: 100, deferred: 1 })
    expect(await k.deliveries(sub.id)).toHaveLength(100)
    await dispatchWebhooks({ ...metered(new TickBudget(100)), budget: new TickBudget(10) })
    expect(await k.deliveries(sub.id)).toHaveLength(101)
  })
})
