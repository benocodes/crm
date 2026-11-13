import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Webhook } from 'standardwebhooks'
import type { StorageBinding } from '@vibase/storage'
import { KEY_BYTES } from '../test/webhook-kit.js'
import { ok, openSenderKit, READ_SCOPES, type FetchCall, type SenderKit } from '../test/sender-kit.js'
import { TickBudget } from './budget.js'

// API7 cycle 3 / API220 (D6 send half, D7, D8, D9, D12, D15): the sender claims due delivery rows under a lease, signs, POSTs and records. The kit drives `sendWebhooks` as the cron does
// (after dispatch) on a movable clock, with a fake `fetch` the test answers and manual timers for the attempt timeout.
let s: SenderKit
beforeAll(async () => {
  s = await openSenderKit()
})
afterAll(() => s.close())
beforeEach(() => s.reset())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const iso = (ms: number) => new Date(ms).toISOString()
const SCHEDULE_MS = [30_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000]
const raw = (sql: string, ...binds: unknown[]) => s.k.all(sql, ...binds)
const setRow = (id: string, set: string, ...binds: unknown[]) => s.k.e.d1!.prepare(`UPDATE webhook_deliveries SET ${set} WHERE id = ?`).bind(...binds, id).run()
const state = async (subscriptionId: string) => (await raw('select * from webhook_dispatch_state where subscription_id = ?', subscriptionId))[0]!
/** Wraps the binding so each executed operation is recorded with what it ran (and, for `failing`, one operation throws before anything is written). */
function spy(failing?: string) {
  const ops: { name: string; reads: number; writes: number }[] = []
  const base = s.k.deps().binding
  const binding = {
    ...base,
    runtime: {
      ...base.runtime,
      execute: async (identity: any, prepared: any) => {
        if (prepared.name === failing) throw new Error('boom')
        const r = await base.runtime.execute(identity, prepared)
        ops.push({ name: prepared.name, reads: r.stats.reads, writes: r.stats.writes })
        return r
      },
    },
  } as StorageBinding
  return { ops, binding }
}
const answer = (status: number) => () => new Response(status === 204 ? null : 'response body that must never be stored', { status })

/** `subs` subscriptions of one agent each, then `tasks` task events, dispatched once: `subs * tasks` due rows. */
const fill = async (subs: number, tasks: number) => {
  const ids: string[] = []
  for (let i = 0; i < subs; i++) ids.push((await s.subscribe()).sub.id)
  for (let n = 0; n < tasks; n++) await s.k.task(`t${n}`)
  await s.k.dispatch()
  return ids
}

describe('signing and body (D7, D8, D12)', () => {
  it('sends the event record exactly as events.get builds it, the signed bytes being the sent bytes, with exactly the five headers; the signature verifies with the secret shown at create', async () => {
    const { sub } = await s.subscribe()
    const { delivery, event } = await s.due(sub.id)
    const summary = await s.send()
    expect(summary.sent).toBe(1)
    expect(s.calls).toHaveLength(1)
    const c = s.calls[0]!
    expect(c.method).toBe('POST')
    expect(c.url).toBe('https://receiver.example/hook')
    expect(Object.keys(c.headers).sort()).toEqual(['Content-Type', 'User-Agent', 'webhook-id', 'webhook-signature', 'webhook-timestamp'])
    expect(c.headers['Content-Type']).toBe('application/json')
    expect(c.headers['User-Agent']).toBe('vibase-webhooks/1')
    expect(c.headers['webhook-id']).toBe(event)
    expect(c.headers['webhook-timestamp']).toBe(String(Math.floor(s.now() / 1000)))
    const got = await s.k.owner('GET', `/api/v1/events/${event}`)
    expect(got.status).toBe(200)
    expect(JSON.parse(c.body)).toEqual(got.body)
    // The library verifies the bytes that were sent, at the fake clock's time.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(s.now())
    expect(new Webhook(sub.secret).verify(c.body, c.headers)).toEqual(got.body)
    expect((await s.row(delivery)).status).toBe('delivered')
  })

  it('after a rotation two signatures go out and each verifies alone; past 24 hours one again, the new one only', async () => {
    const { sub } = await s.subscribe()
    const rotated = await s.k.owner('POST', `/meta/v1/webhooks/${sub.id}/rotate-secret`)
    expect(rotated.status, rotated.text).toBeLessThan(300)
    const s2 = rotated.body.secret as string
    await s.due(sub.id, 'first')
    await s.send()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(s.now())
    const a = s.calls[0]!
    expect(a.headers['webhook-signature']!.split(' ')).toHaveLength(2)
    expect(a.headers['webhook-signature']!.split(' ')[0]).toBe(new Webhook(s2).sign(a.headers['webhook-id']!, new Date(Number(a.headers['webhook-timestamp']) * 1000), a.body))
    for (const secret of [sub.secret, s2]) expect(() => new Webhook(secret).verify(a.body, a.headers)).not.toThrow()
    for (const secret of [sub.secret, s2]) {
      const alone = { ...a.headers, 'webhook-signature': a.headers['webhook-signature']!.split(' ')[secret === s2 ? 0 : 1]! }
      expect(() => new Webhook(secret).verify(a.body, alone)).not.toThrow()
      const other = secret === s2 ? sub.secret : s2
      expect(() => new Webhook(other).verify(a.body, alone)).toThrow()
    }
    vi.useRealTimers()
    s.advance(24 * 3_600_000 + 60_000)
    await s.due(sub.id, 'second')
    await s.send()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(s.now())
    const b = s.calls[1]!
    expect(b.headers['webhook-signature']!.split(' ')).toHaveLength(1)
    expect(() => new Webhook(s2).verify(b.body, b.headers)).not.toThrow()
    expect(() => new Webhook(sub.secret).verify(b.body, b.headers)).toThrow()
  })

  it('the secret in the log and in the rows: nothing the sender logs or stores holds a secret, the sealed text or the key', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    const logs: string[] = []
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(' ')))
    s.handler = answer(500)
    await s.send()
    const sealed = (await raw('select sealed from webhook_secrets')).map((r) => r.sealed as string)
    const everything = logs.join('\n') + JSON.stringify(await s.row(delivery))
    for (const secret of [sub.secret, ...sealed, Buffer.from(KEY_BYTES).toString('base64')]) expect(everything).not.toContain(secret)
    expect(everything).not.toContain('whsec_')
  })
})

describe('outcomes and the retry schedule (D9)', () => {
  it.each([200, 204])('a %i is delivered: the row, the attempt, the status code, the cleared lease and the subscription\'s last_success_at', async (code) => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.handler = answer(code)
    const summary = await s.send()
    expect(summary).toMatchObject({ sent: 1, failed: 0, dead: 0, cancelled: 0, deferred: 0 })
    expect(await s.row(delivery)).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: code, last_error: null, delivered_at: iso(s.now()), last_attempt_at: iso(s.now()), lease_until: null, lease_token: null })
    expect((await state(sub.id)).last_success_at).toBe(iso(s.now()))
    await s.send()
    expect(s.calls).toHaveLength(1)
  })

  it('a 500 stays pending with http_status, and the next delay is 30 s within plus or minus 20 percent, pinned at both random extremes', async () => {
    const { sub } = await s.subscribe()
    const a = await s.due(sub.id, 'low')
    const b = await s.due(sub.id, 'high')
    s.handler = answer(500)
    await s.send({ random: () => 0 })
    const low = await s.row(a.delivery)
    expect(low).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_status', last_status_code: 500, lease_until: null, lease_token: null, delivered_at: null })
    expect(Date.parse(low.next_attempt_at) - s.now()).toBe(24_000)
    // The second row was sent in the same tick with the same random source; a separate tick at the other extreme.
    await setRow(b.delivery, 'attempts = 0, next_attempt_at = ?, last_error = null, last_status_code = null', iso(s.now()))
    await s.send({ random: () => 0.9999999 })
    const high = await s.row(b.delivery)
    expect(Date.parse(high.next_attempt_at) - s.now()).toBeGreaterThanOrEqual(35_999)
    expect(Date.parse(high.next_attempt_at) - s.now()).toBeLessThanOrEqual(36_000)
    expect((await state(sub.id)).last_success_at).toBeNull()
  })

  it('a 302 is not followed (redirect: manual) and is a failure with the code redirect', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.handler = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })
    await s.send()
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.redirect).toBe('manual')
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'redirect', last_status_code: 302 })
  })

  it('a fetch that hangs is aborted by a 10 s timer and recorded as timeout, with no status code', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.autoFire = true
    s.handler = (c: FetchCall) => new Promise<Response>((_, reject) => c.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const summary = await s.send()
    expect(s.timers.map((t) => t.ms)).toEqual([10_000])
    expect(s.timers[0]!.fired).toBe(true)
    expect(s.calls[0]!.signal?.aborted).toBe(true)
    expect(summary.failed).toBe(1)
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'timeout', last_status_code: null })
  })

  it('a fetch that ignores the abort signal is still cut off at the timer', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.autoFire = true
    s.handler = () => new Promise<Response>(() => {})
    await s.send()
    expect((await s.row(delivery)).last_error).toBe('timeout')
  })

  it('a thrown fetch is connection_failed, and no timer is left running', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.handler = () => Promise.reject(new TypeError('fetch failed'))
    await s.send()
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'connection_failed', last_status_code: null })
    expect(s.timers.every((t) => !t.fired)).toBe(true)
  })

  it.each([410, 429, 503])('a %i is an ordinary failure in this cycle (API227 changes it): pending, http_status, the subscription still active', async (code) => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.handler = answer(code)
    await s.send()
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_status', last_status_code: code })
    expect(Date.parse((await s.row(delivery)).next_attempt_at) - s.now()).toBe(30_000)
    expect((await s.k.owner('GET', `/meta/v1/webhooks/${sub.id}`)).body.status).toBe('active')
  })

  it('the delays after the first seven failures are 30 s, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, and the eighth failure ends the row dead with the lease cleared', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.handler = answer(500)
    for (let attempt = 1; attempt <= 7; attempt++) {
      await s.send()
      const r = await s.row(delivery)
      expect(r, `attempt ${attempt}`).toMatchObject({ status: 'pending', attempts: attempt, lease_until: null, lease_token: null })
      expect(Date.parse(r.next_attempt_at) - s.now(), `attempt ${attempt}`).toBe(SCHEDULE_MS[attempt - 1])
      s.advance(SCHEDULE_MS[attempt - 1]!)
    }
    const summary = await s.send()
    expect(summary.dead).toBe(1)
    expect(await s.row(delivery)).toMatchObject({ status: 'dead', attempts: 8, last_error: 'http_status', last_status_code: 500, lease_until: null, lease_token: null, delivered_at: null })
    s.advance(100 * 86_400_000)
    await s.send()
    expect(s.calls).toHaveLength(8)
    expect((await s.k.owner('GET', `/meta/v1/webhooks/${sub.id}`)).body.status).toBe('active')
  })

  it('a row not yet due is not sent, and a response body is never stored in any column', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    s.handler = answer(500)
    await s.send()
    await s.send()
    expect(s.calls).toHaveLength(1)
    expect(JSON.stringify(await s.row(delivery))).not.toContain('response body that must never be stored')
    expect(JSON.stringify(await raw('select * from webhook_dispatch_state'))).not.toContain('response body')
  })
})

describe('leases and attempts at claim (D15, D10)', () => {
  const live = (id: string, attempts: number) => setRow(id, 'attempts = ?, lease_until = ?, lease_token = ?', attempts, iso(s.now() + 20_000), '0190b2c4-0000-7000-8000-0000000000aa')

  it('a row under another sender\'s live lease is neither claimed nor fetched, and is left exactly as it was', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    await live(delivery, 1)
    const before = await s.row(delivery)
    const summary = await s.send()
    expect(s.calls).toHaveLength(0)
    expect(summary).toMatchObject({ sent: 0, failed: 0, dead: 0, cancelled: 0 })
    expect(await s.row(delivery)).toEqual(before)
  })

  it('a claim whose attempt never records is counted at the next claim after the lease lapses', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    const crashing = spy('webhooks.send_record')
    s.handler = answer(200)
    await s.send({ binding: crashing.binding }).catch(() => {}) // the record is lost: the sender "crashed" after its fetch
    expect(s.calls).toHaveLength(1)
    const stuck = await s.row(delivery)
    expect(stuck).toMatchObject({ status: 'pending', attempts: 1 })
    expect(stuck.lease_token).not.toBeNull()
    expect(Date.parse(stuck.lease_until)).toBe(s.now() + 30_000)
    await s.send() // still leased: nothing
    expect(s.calls).toHaveLength(1)
    s.advance(31_000)
    await s.send()
    expect(s.calls).toHaveLength(2)
    expect(await s.row(delivery)).toMatchObject({ status: 'delivered', attempts: 2 })
  })

  it('a row whose attempts are spent and whose lease lapsed ends dead with sender_failed and no fetch; under a live lease it is left alone', async () => {
    const { sub } = await s.subscribe()
    const a = await s.due(sub.id, 'spent and lapsed')
    const b = await s.due(sub.id, 'spent and live')
    await setRow(a.delivery, 'attempts = 8, lease_until = ?, lease_token = ?', iso(s.now() - 1_000), '0190b2c4-0000-7000-8000-0000000000aa')
    await live(b.delivery, 8)
    const summary = await s.send()
    expect(s.calls).toHaveLength(0)
    expect(summary.dead).toBe(1)
    expect(await s.row(a.delivery)).toMatchObject({ status: 'dead', attempts: 8, last_error: 'sender_failed', lease_until: null, lease_token: null })
    expect(await s.row(b.delivery)).toMatchObject({ status: 'pending', attempts: 8 })
  })

  it('a stale sender\'s record after a re-claim changes nothing', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    s.handler = async () => {
      if (s.calls.length === 1) {
        await gate
        return new Response(null, { status: 500 })
      }
      return new Response(null, { status: 200 })
    }
    const stale = s.send()
    await vi.waitFor(() => expect(s.calls).toHaveLength(1))
    s.advance(31_000)
    await s.send() // the lease lapsed: a second sender re-claims and delivers
    expect(await s.row(delivery)).toMatchObject({ status: 'delivered', attempts: 2, last_status_code: 200 })
    release()
    await stale
    expect(await s.row(delivery)).toMatchObject({ status: 'delivered', attempts: 2, last_status_code: 200, last_error: null, lease_until: null, lease_token: null })
  })

  it('no fetch outlives its row\'s lease: waves claim as they go, so a late attempt has its own lease (24 rows, a slow wave each time)', async () => {
    await fill(3, 8)
    const seen: { at: number; leaseUntil: number }[] = []
    s.handler = async (c) => {
      const n = s.calls.length
      const row = (await raw('select lease_until from webhook_deliveries where event_id = ? and lease_until is not null', c.headers['webhook-id']))[0]!
      seen.push({ at: c.at, leaseUntil: Date.parse(row.lease_until) })
      if (n % 5 === 0) s.advance(9_000) // the wave's slowest attempt takes 9 s
      return ok(200)
    }
    const summary = await s.send()
    expect(summary.sent).toBe(24)
    expect(Math.max(...seen.map((x) => x.at)) - Math.min(...seen.map((x) => x.at))).toBeGreaterThanOrEqual(36_000)
    for (const x of seen) expect(x.at + 10_000, 'the fetch may run to its 10 s timeout inside its own lease').toBeLessThanOrEqual(x.leaseUntil)
  })
})

describe('send-time checks (D3, D6, D12)', () => {
  it('a deleted subscription cancels the row with cancelled_subscription and makes no fetch', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    expect((await s.k.owner('DELETE', `/meta/v1/webhooks/${sub.id}`)).status).toBeLessThan(300)
    const summary = await s.send()
    expect(s.calls).toHaveLength(0)
    expect(summary.cancelled).toBe(1)
    expect(await s.row(delivery)).toMatchObject({ status: 'cancelled', last_error: 'cancelled_subscription', lease_until: null, lease_token: null })
  })

  it('a disabled agent, a removed events:read and a removed type scope each cancel the row with cancelled_scope and make no fetch', async () => {
    const cases: [string, (agent: string) => Promise<unknown>][] = [
      ['disabled agent', (a) => s.k.e.d1!.prepare('UPDATE agents SET disabled_at = ? WHERE id = ?').bind(iso(s.now()), a).run()],
      ['events:read removed', (a) => s.k.grant(a, ['tasks:read'])],
      ['the type\'s read scope removed', (a) => s.k.grant(a, ['events:read'])],
    ]
    for (const [name, change] of cases) {
      await s.reset()
      const { agent, sub } = await s.subscribe()
      const { delivery } = await s.due(sub.id)
      await change(agent)
      const summary = await s.send()
      expect(s.calls, name).toHaveLength(0)
      expect(summary.cancelled, name).toBe(1)
      expect(await s.row(delivery), name).toMatchObject({ status: 'cancelled', last_error: 'cancelled_scope', lease_until: null, lease_token: null })
    }
  })

  it('a paused subscription is not attempted over two ticks and its attempts do not advance; it is delivered after status active', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    expect((await s.k.owner('PATCH', `/meta/v1/webhooks/${sub.id}`, { status: 'paused' })).status).toBeLessThan(300)
    await s.send()
    s.advance(60_000)
    await s.send()
    expect(s.calls).toHaveLength(0)
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 0, lease_token: null })
    expect((await s.k.owner('PATCH', `/meta/v1/webhooks/${sub.id}`, { status: 'active' })).status).toBeLessThan(300)
    await s.send()
    expect(s.calls).toHaveLength(1)
    expect(await s.row(delivery)).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  it('a subscription disabled by the vault is held the same way', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    await s.k.e.d1!.prepare("UPDATE webhook_subscriptions SET status = 'disabled' WHERE id = ?").bind(sub.id).run()
    await s.send()
    expect(s.calls).toHaveLength(0)
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('the url read at send time is the one fetched, not the url at dispatch', async () => {
    const { sub } = await s.subscribe({ url: 'https://old.example/hook' })
    await s.due(sub.id)
    expect((await s.k.owner('PATCH', `/meta/v1/webhooks/${sub.id}`, { url: 'https://new.example/other' })).status).toBeLessThan(300)
    await s.send()
    expect(s.calls.map((c) => c.url)).toEqual(['https://new.example/other'])
  })

  it('without CREDENTIALS_KEY nothing is claimed or written, and the log names the variable and no value', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    const before = await s.row(delivery)
    const logs: string[] = []
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(' ')))
    const probe = spy()
    const summary = await s.send({ key: null, binding: probe.binding })
    expect(summary.noKey).toBe(true)
    expect(s.calls).toHaveLength(0)
    expect(probe.ops).toEqual([])
    expect(await s.row(delivery)).toEqual(before)
    expect(logs.join('\n')).toContain('CREDENTIALS_KEY')
  })

  it('a key that cannot open a secret records sender_failed as a failed attempt, with no fetch', async () => {
    const { sub } = await s.subscribe()
    const { delivery } = await s.due(sub.id)
    const summary = await s.send({ key: Uint8Array.from({ length: 32 }, () => 9) })
    expect(s.calls).toHaveLength(0)
    expect(summary.failed).toBe(1)
    expect(await s.row(delivery)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'sender_failed', last_status_code: null, lease_token: null })
  })
})

describe('tick bounds (D6)', () => {
  const pendingNow = async () => ((await raw("select count(*) as n from webhook_deliveries where status = 'pending' and attempts = 0"))[0] as { n: number }).n

  it('60 due rows: at most 50 are claimed in a tick, never more than 5 fetches in flight, and the rest stay pending with attempts 0 and go out on the next tick', async () => {
    await fill(6, 10)
    s.handler = async () => {
      await new Promise((r) => setTimeout(r, 2)) // overlap, so the in-flight count is observable
      return ok(200)
    }
    const summary = await s.send()
    expect(s.calls).toHaveLength(50)
    expect(summary).toMatchObject({ sent: 50, deferred: 10 })
    expect(s.maxInFlight).toBe(5)
    expect(await pendingNow()).toBe(10)
    expect(((await raw("select count(*) as n from webhook_deliveries where status = 'pending' and attempts = 0 and lease_token is null"))[0] as { n: number }).n).toBe(10)
    const next = await s.send()
    expect(next.sent).toBe(10)
    expect(s.calls).toHaveLength(60)
    expect(await pendingNow()).toBe(0)
  })

  it('at most 10 rows of one subscription in a tick, the other subscription is not starved', async () => {
    const [a, b] = await fill(2, 20)
    await s.send()
    const per = async (id: string) => ((await raw("select count(*) as n from webhook_deliveries where subscription_id = ? and attempts = 1", id))[0] as { n: number }).n
    expect([await per(a!), await per(b!)]).toEqual([10, 10])
    expect(s.calls).toHaveLength(20)
    await s.send()
    expect(s.calls).toHaveLength(40)
  })

  it('no attempt starts after 40 s of the tick on the fake clock; the rest wait with attempts 0', async () => {
    await fill(5, 5)
    s.handler = async () => {
      const n = s.calls.length
      await Promise.resolve()
      if (n % 5 === 0) s.advance(15_000)
      return ok(200)
    }
    const started = s.now()
    const summary = await s.send()
    expect(Math.max(...s.calls.map((c) => c.at)) - started).toBeLessThan(40_000)
    expect(s.calls).toHaveLength(15) // waves at 0 s, 15 s and 30 s; the fourth would start at 45 s
    expect(summary.deferred).toBe(10)
    expect(await pendingNow()).toBe(10)
  })

  it('the 40 s are the tick\'s, not the sender\'s: a sender started late in a tick has less time', async () => {
    await fill(3, 4)
    s.handler = async () => {
      const n = s.calls.length
      await Promise.resolve()
      if (n % 5 === 0) s.advance(2_000)
      return ok(200)
    }
    const tickStart = new Date(s.now() - 38_000)
    await s.send({ startedAt: tickStart })
    expect(s.calls).toHaveLength(5) // a wave starts 38 s into the tick and takes 2 s; the next would start at 40 s
  })

  it('no due row: one read, no write, no claim', async () => {
    const probe = spy()
    const summary = await s.send({ binding: probe.binding })
    expect(summary).toEqual({ sent: 0, failed: 0, dead: 0, cancelled: 0, deferred: 0, noKey: false })
    expect(probe.ops).toEqual([{ name: 'webhooks.send_claim', reads: 1, writes: 0 }])
    expect(s.calls).toHaveLength(0)
  })

  it('a wave costs four queries (claim read and write, context read, record) and one fetch a row', async () => {
    await fill(1, 3)
    const probe = spy()
    await s.send({ binding: probe.binding })
    // The claim is a read batch and a write batch (the lease update and the result select); the context one read batch; the record one write batch.
    expect(probe.ops.map((o) => `${o.name}:${o.reads > 0 ? 'r' : ''}${o.writes > 0 ? 'w' : ''}`)).toEqual(['webhooks.send_claim:rw', 'webhooks.send_context:r', 'webhooks.send_record:w'])
    expect(s.calls).toHaveLength(3)
  })
})

describe('the budget (D24), as the sender meets it', () => {
  const meter = (limit: number) => {
    const b = new TickBudget(limit)
    const base = s.k.deps().binding
    const binding = {
      ...base,
      runtime: {
        ...base.runtime,
        execute: async (identity: any, prepared: any) => {
          const r = await base.runtime.execute(identity, prepared)
          b.spend(r.stats.roundTrips)
          return r
        },
      },
    } as StorageBinding
    return { b, binding }
  }

  it('claims only what the budget can finish: queries plus fetches never exceed it, unserved rows keep attempts 0, and the summary counts them deferred', async () => {
    await fill(2, 5) // 10 due rows
    const { b, binding } = meter(14) // one wave of 5 costs 4 + 5 = 9; a second does not fit in the 5 left (4 + 1 fits only one row)
    s.handler = () => {
      b.spend(1)
      return ok(200)
    }
    const summary = await s.send({ binding, budget: b })
    expect(b.used).toBeLessThanOrEqual(14)
    expect(summary.sent).toBe(s.calls.length)
    expect(summary.sent).toBeGreaterThanOrEqual(5)
    expect(summary.sent).toBeLessThan(10)
    expect(summary.deferred).toBe(10 - summary.sent)
    expect(((await raw("select count(*) as n from webhook_deliveries where attempts = 0 and status = 'pending'"))[0] as { n: number }).n).toBe(10 - summary.sent)
  })

  it('a budget too small for the smallest wave starts nothing, writes nothing and reads nothing', async () => {
    await fill(1, 5)
    const probe = spy()
    const summary = await s.send({ binding: probe.binding, budget: { remaining: () => 4 } })
    expect(probe.ops).toEqual([])
    expect(s.calls).toHaveLength(0)
    expect(summary.sent).toBe(0)
  })
})
