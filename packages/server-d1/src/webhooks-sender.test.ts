import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { MIGRATIONS } from '@vibase/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { FakeTransport, TEST_TRANSPORT, registerTestOperations } from '@vibase/api/test/rail'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, meterD1, openWorkerD1, type WorkerD1 } from './test/kit.js'

// API220 (D6 send half, D24): the per-minute expression sends webhooks after dispatch, inside one budget of D1 queries plus outbound fetches shared with the rail. The sender's and dispatcher's own
// behaviour is proven in @vibase/api; here only the composition: the one handler, its order, the key gate, the budget, its configuration and its log line.
let w: WorkerD1
let key: string
let now = NOW
const BASE = 'https://w.test'
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const SCOPES = ['webhooks:read', 'webhooks:write', 'events:read', 'tasks:read', 'tasks:write', 'tasks:request_approval', 'action_requests:read']
const NAMES = MIGRATIONS.map((m) => m.name)
const transport = new FakeTransport()
let fetches: { url: string; init: RequestInit }[] = []
let answerWith = 200
const hook: typeof fetch = async (input, init) => {
  fetches.push({ url: String(input), init: init ?? {} })
  return new Response(null, { status: answerWith })
}
const worker = (over: Partial<D1WorkerEnv> & { CRON_TICK_BUDGET?: string } = {}, d1 = w.d1) =>
  composeD1Worker({ DB: d1, AUTH_PROVIDER: '', CREDENTIALS_KEY: KEY, ...over } as D1WorkerEnv, { fetch: hook, clock: () => now, nowMs: () => 0, newId: () => uuidv7(now), operations: registerTestOperations, transports: { [TEST_TRANSPORT]: transport } })
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown) => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }))
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
const rows = async (sqlText: string) => ((await w.d1.prepare(sqlText).all()).results ?? []) as Array<Record<string, any>>
const subscribe = async (wk: ReturnType<typeof worker>, n = 1) => {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await call(wk, 'POST', '/meta/v1/webhooks', { url: `https://receiver.example/hook/${i}`, event_types: ['task.created'] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    ids.push(r.body.id)
  }
  return ids
}
const task = async (wk: ReturnType<typeof worker>, title: string) => expect((await call(wk, 'POST', '/api/v1/tasks', { title })).status).toBe(201)
const logs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]))

beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  now = NOW
  fetches = []
  answerWith = 200
  transport.reset()
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  key = (await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: SCOPES }, { now: NOW, newId: () => uuidv7(NOW) })).key
})
afterEach(() => vi.restoreAllMocks())

describe('the per-minute handler sends webhooks after dispatch (D6)', () => {
  it('one tick dispatches and sends: a signed POST reaches the subscription\'s url, the row is delivered, and the sender\'s log line follows the dispatcher\'s', async () => {
    const wk = worker()
    const [id] = await subscribe(wk)
    await task(wk, 'send me')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await wk.scheduled({ cron: '* * * * *' })
    expect(fetches).toHaveLength(1)
    expect(fetches[0]!.url).toBe('https://receiver.example/hook/0')
    expect(Object.keys(fetches[0]!.init.headers as Record<string, string>).sort()).toEqual(['Content-Type', 'User-Agent', 'webhook-id', 'webhook-signature', 'webhook-timestamp'])
    expect(await rows('select subscription_id, status, attempts, last_status_code from webhook_deliveries')).toEqual([{ subscription_id: id, status: 'delivered', attempts: 1, last_status_code: 200 }])
    const lines = logs(log)
    const dispatched = lines.findIndex((l) => l.includes('webhooks dispatched 1 event(s) for 1 subscription(s)'))
    const sent = lines.findIndex((l) => l.includes('webhooks sent 1, failed 0, dead 0, cancelled 0, deferred 0'))
    expect(dispatched, lines.join('\n')).toBeGreaterThanOrEqual(0)
    expect(sent, lines.join('\n')).toBeGreaterThan(dispatched)
    await wk.scheduled({ cron: '* * * * *' })
    expect(fetches).toHaveLength(1)
  })

  it('without CREDENTIALS_KEY rows are still dispatched, nothing is sent or claimed, and the log names the variable', async () => {
    const wk = worker({ CREDENTIALS_KEY: undefined })
    await call(worker(), 'POST', '/meta/v1/webhooks', { url: 'https://receiver.example/hook', event_types: ['task.created'] })
    await task(wk, 'keyless')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await wk.scheduled({ cron: '* * * * *' })
    expect(fetches).toEqual([])
    expect(await rows('select status, attempts, lease_token from webhook_deliveries')).toEqual([{ status: 'pending', attempts: 0, lease_token: null }])
    expect([...logs(log), ...logs(warn)].join('\n')).toContain('CREDENTIALS_KEY')
    expect([...logs(log), ...logs(warn)].join('\n')).not.toContain(KEY)
  })

  it('a failing sender does not undo the rail or dispatch, and the failure is raised after all three ran', async () => {
    const wk = worker()
    await subscribe(wk)
    await task(wk, 'sender is down')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const breaking = new Proxy(w.d1, { get: (t: any, p) => (p === 'prepare' ? (q: string) => (/lease_token/.test(q) && /webhook_deliveries/.test(q) ? (() => { throw new Error('database fault') })() : t.prepare(q)) : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) }) as typeof w.d1
    await expect(worker({}, breaking).scheduled({ cron: '* * * * *' })).rejects.toThrow()
    expect(await rows('select status from webhook_deliveries')).toEqual([{ status: 'pending' }])
    expect(logs(error).join('\n')).toContain('webhook send failed')
  })

  it('the 15-minute expression sends nothing', async () => {
    const wk = worker()
    await subscribe(wk)
    await task(wk, 'not yet')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await wk.scheduled({ cron: '*/15 * * * *' })
    expect(fetches).toEqual([])
  })
})

// The rail's worst case (100 overdue requests, 5 due executions: 24 queries) plus 10 subscriptions (an agent may own ten) that each have a backlog of three events to dispatch, so dispatch and the sender both want more
// than the 50 Workers Free allows in all. Counted: every D1 query (a batch is one) and every outbound fetch the sender and the rail's transports make.
describe('one budget for the whole tick (D24)', () => {
  const SUBS = 10
  async function fixture(env: { CRON_TICK_BUDGET?: string } = {}) {
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, NAMES)
    const wk = worker()
    const meter = meterD1(w.d1)
    const metered = worker(env, meter.d1)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await metered.scheduled({ cron: '* * * * *' }) // a warm isolate: the marker and the migration state are read once, on an empty tick
    await subscribe(wk, SUBS)
    for (let i = 0; i < 3; i++) await task(wk, `backlog ${i}`)
    for (let i = 0; i < 5; i++) await call(wk, 'POST', '/api/v1/test-enqueue', { text: 'x', idempotency_key: `k${i}` })
    for (let i = 0; i < 100; i++) await call(wk, 'POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: `t${i}` }, reason: 'r', expires_at: new Date(now.getTime() + 60_000 + i * 1000).toISOString() })
    now = new Date(now.getTime() + 200_000)
    return { meter, metered }
  }
  async function tick(f: Awaited<ReturnType<typeof fixture>>) {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const before = fetches.length
    f.meter.start()
    await f.metered.scheduled({ cron: '* * * * *' })
    wallClock.mockRestore()
    return { m: f.meter.take(), fetched: fetches.length - before }
  }
  const cursors = async () => (await rows('select cursor_event_id from webhook_dispatch_state order by subscription_id')).map((r) => r.cursor_event_id as string)

  it('the default budget of 50: queries plus fetches stay within it, dispatch defers the subscriptions it could not afford (their cursors stay), the sender defers its rows, and the log counts them', async () => {
    const f = await fixture()
    const before = await cursors()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { m, fetched } = await tick(f)
    console.log('MEASURE ' + JSON.stringify({ key: 'webhooks-tick-10-subs', ...m, fetched }))
    expect(m.queries + fetched).toBeLessThanOrEqual(50)
    const dispatchLine = logs(log).filter((l) => l.includes('webhooks dispatched'))
    const sendLine = logs(log).filter((l) => l.includes('webhooks sent'))
    expect(dispatchLine.length).toBeGreaterThan(0)
    expect(sendLine.length).toBeGreaterThan(0)
    const after = await cursors()
    const moved = after.filter((c, i) => c !== before[i]).length
    // The marker read and the rail spent 24 of the 50 (rail.test's pin of 25 less dispatch's own read), so dispatch may spend half of the 26 left: 13, which is the eligibility read and six
    // subscriptions' pages (2 each). The other four keep their cursors.
    expect(moved).toBe(6)
    expect(dispatchLine.join('\n')).toMatch(/4 deferred/)
    expect(sendLine.join('\n')).toMatch(/deferred [1-9]/)
    expect((await rows("select count(*) as n from webhook_deliveries"))[0]!.n).toBeLessThan(SUBS * 3)
    expect(m.maxParameters).toBeLessThanOrEqual(100)
  })

  it('CRON_TICK_BUDGET=1000 completes the same fixture in one tick: every subscription dispatched, every row sent', async () => {
    const { m, fetched } = await tick(await fixture({ CRON_TICK_BUDGET: '1000' }))
    expect(m.queries + fetched).toBeGreaterThan(50)
    expect(m.queries + fetched).toBeLessThanOrEqual(1000)
    expect((await rows('select count(*) as n from webhook_deliveries'))[0]!.n).toBe(SUBS * 3)
    expect((await rows("select count(*) as n from webhook_deliveries where status = 'delivered'"))[0]!.n).toBe(SUBS * 3)
  })

  it.each(['10', 'lots', '5000', '50.5'])('an invalid CRON_TICK_BUDGET (%s) runs at 50 and warns naming the variable, never the tick', async (bad) => {
    const f = await fixture({ CRON_TICK_BUDGET: bad })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { m, fetched } = await tick(f)
    expect(m.queries + fetched).toBeLessThanOrEqual(50)
    expect(logs(warn).join('\n')).toContain('CRON_TICK_BUDGET')
    expect(logs(warn).join('\n')).not.toContain(bad === 'lots' ? 'lots' : `=${bad}`)
  })

  it('deferred subscriptions are served by the next ticks and nothing is lost: after enough ticks every event has one row per subscription, each delivered once', async () => {
    await fixture()
    const wk = worker()
    for (let i = 0; i < 12; i++) {
      now = new Date(now.getTime() + 60_000)
      await wk.scheduled({ cron: '* * * * *' })
    }
    expect((await rows('select count(*) as n from webhook_deliveries'))[0]!.n).toBe(SUBS * 3)
    expect((await rows("select count(*) as n from webhook_deliveries where status = 'delivered' and attempts = 1"))[0]!.n).toBe(SUBS * 3)
    expect(fetches).toHaveLength(SUBS * 3)
  })
})
