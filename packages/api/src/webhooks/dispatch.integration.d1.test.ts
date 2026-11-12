import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { NOW, openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'
import { applyPage, dispatchWebhooks, eligibleSubscriptions, readPage } from './dispatch.js'

// API7 cycle 2 / API219 (D4, D6, D17, D20): the dispatcher turns each eligible subscription's new feed events into `pending` delivery rows and moves its cursor. The kit seeds
// subscriptions through the REST app, events through the app (tasks) or as raw `events` rows (types no operation emits here), and drives `dispatchWebhooks` as the cron does.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())
afterEach(() => vi.restoreAllMocks())

const AT = NOW.toISOString()
const READS = ['tasks:read', 'events:read']
const agentWith = (scopes: string[] = READS) => k.seedAgent(scopes)
const eventCount = async () => ((await k.all('select count(*) as n from events'))[0] as { n: number }).n
const eventIds = (rows: Record<string, any>[]) => rows.map((r) => r.event_id)

describe('dispatch core (D4, D20)', () => {
  it('a committed event becomes exactly one pending row for each matching subscription and none for a non-matching one, with the row shape of the plan', async () => {
    const a = await agentWith()
    const match = await k.create(a, { event_types: ['task.created', 'task.updated'] })
    const other = await k.create(a, { event_types: ['task.updated'] })
    const created = await k.task('dispatch me')
    await k.dispatch()
    const rows = await k.deliveries(match.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      created_at: AT,
      organization_id: k.e.organizationId,
      created_by: k.e.userId,
      subscription_id: match.id,
      event_id: created,
      event_type: 'task.created',
      status: 'pending',
      attempts: 0,
      next_attempt_at: AT,
      lease_until: null,
      lease_token: null,
      last_attempt_at: null,
      last_status_code: null,
      last_error: null,
      delivered_at: null,
    })
    expect(await k.deliveries(other.id)).toEqual([])
    expect(await k.cursorOf(match.id)).toBe(created)
    expect(await k.cursorOf(other.id), 'the other subscription read the same page and saw nothing of its types: its cursor does not move').not.toBe(created)
  })

  it('a second tick adds nothing and leaves the cursor', async () => {
    const made = await k.create(await agentWith())
    const created = await k.task('once')
    await k.dispatch()
    const first = await k.deliveries()
    await k.dispatch()
    expect(await k.deliveries()).toEqual(first)
    expect(await k.cursorOf(made.id)).toBe(created)
  })

  it('no event after the cursor: no row, the cursor unchanged', async () => {
    const made = await k.create(await agentWith())
    const before = await k.cursorOf(made.id)
    const out = await k.dispatch()
    expect(await k.deliveries()).toEqual([])
    expect(await k.cursorOf(made.id)).toBe(before)
    expect(out.events).toBe(0)
  })

  it('520 matching events: 500 rows and the cursor at the 500th in one tick (5 pages of 100), the rest on the next', async () => {
    const made = await k.create(await agentWith())
    const ids: string[] = []
    const stmts = []
    for (let i = 0; i < 520; i++) {
      const id = uuidv7()
      ids.push(id)
      stmts.push(k.e.d1!.prepare("INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) VALUES (?, ?, ?, 'task.created', 'task', ?, ?)").bind(id, AT, k.e.organizationId, uuidv7(), k.e.userId))
    }
    await k.e.d1!.batch(stmts)
    await k.dispatch()
    expect(await k.deliveries(made.id)).toHaveLength(500)
    expect(await k.cursorOf(made.id)).toBe(ids[499])
    await k.dispatch()
    const rows = await k.deliveries(made.id)
    expect(rows).toHaveLength(520)
    expect(new Set(eventIds(rows))).toEqual(new Set(ids))
    expect(await k.cursorOf(made.id)).toBe(ids[519])
  })

  it('dispatch adds no row to events and writes no updated_at on the subscription (D20)', async () => {
    const made = await k.create(await agentWith())
    await k.task('quiet')
    const stamp = (await k.all('select updated_at from webhook_subscriptions where id = ?', made.id))[0]
    const before = await eventCount()
    await k.dispatch()
    expect(await eventCount()).toBe(before)
    expect((await k.deliveries()).length).toBe(1)
    expect((await k.all('select updated_at from webhook_subscriptions where id = ?', made.id))[0]).toEqual(stamp)
  })

  it('last_dispatched_at is stamped when a page was applied, and left alone on an empty read', async () => {
    const made = await k.create(await agentWith())
    await k.dispatch()
    expect((await k.all('select last_dispatched_at from webhook_dispatch_state'))[0]).toEqual({ last_dispatched_at: null })
    await k.task('stamp')
    await k.dispatch()
    expect((await k.all('select last_dispatched_at from webhook_dispatch_state where subscription_id = ?', made.id))[0]).toEqual({ last_dispatched_at: AT })
  })
})

describe('overlapping dispatches (D4, invariant 3): asserted on the cursor itself', () => {
  const setup = async () => {
    const made = await k.create(await agentWith())
    const e1 = await k.rawEvent('task.created')
    const e2 = await k.rawEvent('task.created')
    const target = (await eligibleSubscriptions(k.deps()))[0]!
    const stale = await readPage(k.deps(), target) // read at the cursor: e1, e2
    const e3 = await k.rawEvent('task.created')
    const newer = await readPage(k.deps(), target) // the same cursor read, now with e3
    return { made, e1, e2, e3, stale, newer }
  }

  it('the newer run applied first, then the stale one: each row once, the cursor stays at the newer position (a stale run must not move it back)', async () => {
    const { made, e1, e2, e3, stale, newer } = await setup()
    expect((newer as any).events.map((e: any) => e.id)).toEqual([e1, e2, e3])
    await applyPage(k.deps(), newer)
    await applyPage(k.deps(), stale)
    expect(eventIds(await k.deliveries(made.id)).sort()).toEqual([e1, e2, e3].sort())
    expect(await k.cursorOf(made.id)).toBe(e3)
  })

  it('the stale run applied first, then the newer: each row once, the first to apply wins the cursor and the next tick converges with no duplicate', async () => {
    const { made, e1, e2, e3, stale, newer } = await setup()
    await applyPage(k.deps(), stale)
    expect(await k.cursorOf(made.id)).toBe(e2)
    const second = await applyPage(k.deps(), newer)
    expect(second.moved, 'the loser matched no cursor row').toBe(false)
    expect(await k.cursorOf(made.id)).toBe(e2)
    expect(eventIds(await k.deliveries(made.id)).sort()).toEqual([e1, e2, e3].sort())
    await k.dispatch()
    expect(await k.cursorOf(made.id)).toBe(e3)
    expect(await k.deliveries(made.id)).toHaveLength(3)
  })

  it('two runs that read the very same page, applied one after the other in either order: each row once and the cursor at that page', async () => {
    const made = await k.create(await agentWith())
    const e1 = await k.rawEvent('task.created')
    const e2 = await k.rawEvent('task.created')
    const target = (await eligibleSubscriptions(k.deps()))[0]!
    const a = await readPage(k.deps(), target)
    const b = await readPage(k.deps(), target)
    expect((await applyPage(k.deps(), a)).moved).toBe(true)
    expect((await applyPage(k.deps(), b)).moved).toBe(false)
    expect(eventIds(await k.deliveries(made.id))).toEqual([e1, e2])
    expect(await k.cursorOf(made.id)).toBe(e2)
  })
})

describe('eligibility and visibility at dispatch (one case per condition)', () => {
  const rowsAfterOneTask = async (sub: { id: string }) => {
    await k.task('eligibility')
    await k.dispatch()
    return k.deliveries(sub.id)
  }

  it('control: an active subscription of a live agent holding events:read and the read scope gets its row', async () => {
    const sub = await k.create(await agentWith())
    expect(await rowsAfterOneTask(sub)).toHaveLength(1)
  })

  it('paused: no rows and the cursor held; after status active the backlog is dispatched', async () => {
    const sub = await k.create(await agentWith())
    const held = await k.cursorOf(sub.id)
    expect((await k.owner('PATCH', `/meta/v1/webhooks/${sub.id}`, { status: 'paused' })).status).toBe(200)
    expect(await rowsAfterOneTask(sub)).toEqual([])
    expect(await k.cursorOf(sub.id)).toBe(held)
    expect((await k.owner('PATCH', `/meta/v1/webhooks/${sub.id}`, { status: 'active' })).status).toBe(200)
    await k.dispatch()
    expect(await k.deliveries(sub.id)).toHaveLength(1)
  })

  it('deleted: no rows', async () => {
    const sub = await k.create(await agentWith())
    await k.owner('DELETE', `/meta/v1/webhooks/${sub.id}`)
    expect(await rowsAfterOneTask(sub)).toEqual([])
  })

  it('disabled (by the vault): no rows', async () => {
    const sub = await k.create(await agentWith())
    await k.e.d1!.prepare("UPDATE webhook_subscriptions SET status = 'disabled' WHERE id = ?").bind(sub.id).run()
    expect(await rowsAfterOneTask(sub)).toEqual([])
  })

  it('a disabled agent: no rows', async () => {
    const a = await agentWith()
    const sub = await k.create(a)
    await k.e.d1!.prepare('UPDATE agents SET disabled_at = ? WHERE id = ?').bind(AT, a).run()
    expect(await rowsAfterOneTask(sub)).toEqual([])
  })

  it('a delegated agent (seeded after creation): no rows', async () => {
    const a = await agentWith()
    const sub = await k.create(a)
    await k.e.d1!.prepare("UPDATE agents SET auth_provider = 'clerk', auth_client_id = 'client_x', delegated_by = ? WHERE id = ?").bind(k.e.userId, a).run()
    expect(await rowsAfterOneTask(sub)).toEqual([])
  })

  it('an agent without events:read: no rows', async () => {
    const sub = await k.create(await agentWith(['tasks:read']))
    expect(await rowsAfterOneTask(sub)).toEqual([])
  })

  it('an agent losing interactions:read gets no further interaction.created rows', async () => {
    const a = await agentWith(['interactions:read', 'events:read'])
    const sub = await k.create(a, { event_types: ['interaction.created'] })
    await k.rawEvent('interaction.created')
    await k.dispatch()
    expect(await k.deliveries(sub.id)).toHaveLength(1)
    await k.grant(a, ['events:read'])
    await k.rawEvent('interaction.created')
    await k.dispatch()
    expect(await k.deliveries(sub.id)).toHaveLength(1)
  })

  it('an event_types update applies from the current position: nothing before the cursor is replayed, what comes after is delivered', async () => {
    const sub = await k.create(await agentWith(), { event_types: ['task.created'] })
    await k.rawEvent('task.updated') // before the cursor moves on
    const created = await k.task('first')
    await k.dispatch()
    expect(eventIds(await k.deliveries(sub.id))).toEqual([created])
    expect((await k.owner('PATCH', `/meta/v1/webhooks/${sub.id}`, { event_types: ['task.created', 'task.updated'] })).status).toBe(200)
    await k.dispatch()
    expect(eventIds(await k.deliveries(sub.id)), 'the earlier task.updated is not replayed').toEqual([created])
    const later = await k.rawEvent('task.updated')
    await k.dispatch()
    expect(eventIds(await k.deliveries(sub.id))).toEqual([created, later])
  })

  it('unknown_cursor (seeded) skips that subscription, logging its id, without restarting it, while another subscription in the same tick is dispatched', async () => {
    const a = await agentWith()
    const broken = await k.create(a)
    const fine = await k.create(a)
    const missing = uuidv7()
    await k.e.d1!.prepare('UPDATE webhook_dispatch_state SET cursor_event_id = ? WHERE subscription_id = ?').bind(missing, broken.id).run()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await k.task('one')
    const out = await k.dispatch()
    expect(await k.deliveries(broken.id)).toEqual([])
    expect(await k.cursorOf(broken.id)).toBe(missing)
    expect(await k.deliveries(fine.id)).toHaveLength(1)
    expect(out.unknownCursor).toBe(1)
    expect(warn.mock.calls.flat().join(' ')).toContain(broken.id)
    expect(warn.mock.calls.flat().join(' ')).not.toContain(fine.id)
  })

  it('one subscription whose read fails does not stop the rest of the tick', async () => {
    const a = await agentWith()
    const first = await k.create(a)
    const second = await k.create(a)
    await k.task('survive')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = k.deps()
    const real = deps.binding.runtime.execute.bind(deps.binding.runtime)
    let failed = 0
    const binding = {
      ...deps.binding,
      runtime: {
        ...deps.binding.runtime,
        execute: (identity: any, op: any) => {
          if (op.name === 'events.feed' && failed === 0) {
            failed++
            return Promise.reject(new Error('read failed'))
          }
          return real(identity, op)
        },
      },
    } as typeof deps.binding
    const out = await dispatchWebhooks({ ...deps, binding })
    expect(out.failed).toBe(1)
    expect(error).toHaveBeenCalled()
    const counts = [(await k.deliveries(first.id)).length, (await k.deliveries(second.id)).length].sort()
    expect(counts).toEqual([0, 1])
  })
})

describe('messaging events carry no content (D17)', () => {
  it('a capture yields one interaction.created row whose event record has message_id and participants and no preview', async () => {
    const a = await agentWith(['interactions:read', 'events:read'])
    const sub = await k.create(a, { event_types: ['interaction.created'] })
    await runCapture(k.e, { connection_id: uuidv7(), messages: [captureMessage(k.e.organizationId)] })
    await k.dispatch()
    const rows = await k.deliveries(sub.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event_type: 'interaction.created' })
    const event = (await k.all('select "after", "before" from events where id = ?', rows[0]!.event_id))[0] as { after: string }
    const after = JSON.parse(event.after)
    expect(after.message_id).toEqual(expect.any(String))
    expect(after.participants.length).toBeGreaterThan(0)
    expect(JSON.stringify(after)).not.toContain('preview')
    expect(JSON.stringify(after)).not.toContain('Preview')
  })

  it('after messages:read is removed, a new message.created yields no row', async () => {
    const a = await agentWith(['messages:read', 'events:read'])
    const sub = await k.create(a, { event_types: ['message.created'] })
    await runCapture(k.e, { connection_id: uuidv7(), messages: [captureMessage(k.e.organizationId)] })
    await k.dispatch()
    expect(await k.deliveries(sub.id)).toHaveLength(1)
    await k.grant(a, ['events:read'])
    await runCapture(k.e, { connection_id: uuidv7(), messages: [captureMessage(k.e.organizationId)] })
    await k.dispatch()
    expect(await k.deliveries(sub.id)).toHaveLength(1)
  })
})
