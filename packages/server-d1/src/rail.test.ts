import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { uuidv7 } from '@vault/storage'
import { MIGRATIONS } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { FakeTransport, TEST_OPS, TEST_TRANSPORT, registerTestOperations } from '@vault/api/test/rail'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, meterD1, openWorkerD1, type WorkerD1 } from './test/kit.js'

// [[AGT8]] D13, D49, D54, D55, D56: the entry paths of the execution rail through the real Worker composition over a local D1 (Miniflare): the `waitUntil`
// kick, the per-minute cron, the separation from the 15-minute cron, the migration gate, the expiry sweep and the bounded tick. The runner's own
// behaviour is proven in @vault/api against the same fake transport; the real bundle runs the empty tick in workerd (`pnpm smoke:worker`).
let w: WorkerD1
let now = NOW
let key: string
const transport = new FakeTransport()
const BASE = 'https://w.test'
const NAMES = MIGRATIONS.map((m) => m.name)
const SCOPES = ['tasks:read', 'tasks:write', 'tasks:request_approval', 'action_requests:read']
const env = (d1 = w.d1): D1WorkerEnv => ({ DB: d1, AUTH_PROVIDER: '' })
const worker = (d1 = w.d1) => composeD1Worker(env(d1), { clock: () => now, newId: () => uuidv7(now), operations: registerTestOperations, transports: { [TEST_TRANSPORT]: transport } })
const call = (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown, ctx?: { waitUntil(p: Promise<unknown>): void }) =>
  wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx)
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any })
const rows = async (sqlText: string) => ((await w.d1.prepare(sqlText).all()).results ?? []) as Array<Record<string, any>>
const ctxOf = () => {
  const promises: Promise<unknown>[] = []
  return { promises, waitUntil: (p: Promise<unknown>) => void promises.push(p) }
}
const advance = (ms: number) => void (now = new Date(now.getTime() + ms))
let n = 0
const enqueue = async (wk: ReturnType<typeof worker>, ctx?: { waitUntil(p: Promise<unknown>): void }) => json(await call(wk, 'POST', '/api/v1/test-enqueue', { text: 'x', idempotency_key: `k${++n}` }, ctx))
const status = async (id: string) => (await rows(`select status from action_executions where id = '${id}'`))[0]?.status

beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  now = NOW
  await w.reset()
  // A test that made the database look behind leaves its tracker: wrangler's tracker is migration state, which `reset` keeps (CORE61 D10).
  await w.d1.prepare('drop table if exists d1_migrations').run()
  transport.reset()
  const r = await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: SCOPES }, { now: NOW, newId: () => uuidv7(NOW) })
  key = r.key
})
afterEach(() => vi.restoreAllMocks())

describe('the waitUntil kick (D49)', () => {
  it('a direct enqueue starts the runner with waitUntil: the execution is done on the fake once the request\'s promises settle', async () => {
    const ctx = ctxOf()
    const { status: code, body } = await enqueue(worker(), ctx)
    expect(code).toBe(202)
    expect(ctx.promises).toHaveLength(1)
    await Promise.all(ctx.promises)
    expect(await status(body.id)).toBe('done')
    expect(transport.dispatches).toHaveLength(1)
    expect(transport.dispatches[0]!.executionId).toBe(body.id)
  })

  it('an approval starts the runner too', async () => {
    const wk = worker()
    const proposed = await json(await call(wk, 'POST', '/api/v1/action-requests', { operation: TEST_OPS.reconcile, arguments: { text: 'x' }, reason: 'r' }))
    expect(proposed.status).toBe(201)
    const ctx = ctxOf()
    const approved = await json(await call(wk, 'POST', `/api/v1/action-requests/${proposed.body.id}/approve`, undefined, ctx))
    expect(approved.status).toBe(200)
    await Promise.all(ctx.promises)
    expect(await status(approved.body.execution_id)).toBe('done')
    expect((await json(await call(wk, 'GET', `/api/v1/action-requests/${proposed.body.id}`))).body.status).toBe('executed')
  })

  it('a kick that throws or is absent does not change the answer; with no execution context the execution stays queued for the cron', async () => {
    const dropped: Promise<unknown>[] = []
    const thrower = { waitUntil: (p: Promise<unknown>) => { dropped.push(p); throw new Error('dropped') } }
    const a = await enqueue(worker(), thrower)
    expect(a.status).toBe(202)
    await Promise.all(dropped)
    const b = await enqueue(worker()) // no execution context at all
    expect(b.status).toBe(202)
    expect(await status(b.body.id)).toBe('queued')
    expect(transport.dispatches.map((d) => d.executionId)).not.toContain(b.body.id)
  })
})

describe('the per-minute cron (D54)', () => {
  it('with the kick suppressed, scheduled({ cron: "* * * * *" }) runs the execution to done', async () => {
    const wk = worker()
    const { body } = await enqueue(wk)
    advance(1000)
    await wk.scheduled({ cron: '* * * * *' })
    expect(await status(body.id)).toBe('done')
    expect(transport.dispatches).toHaveLength(1)
  })

  it('the cron also runs the expiry sweep: an overdue request is expired by the system principal', async () => {
    const wk = worker()
    const r = await json(await call(wk, 'POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: 't' }, reason: 'r', expires_at: new Date(now.getTime() + 60_000).toISOString() }))
    expect(r.status).toBe(201)
    advance(120_000)
    await wk.scheduled({ cron: '* * * * *' })
    const row = (await rows(`select status, decided_by from action_requests where id = '${r.body.id}'`))[0]!
    expect(row.status).toBe('expired')
    expect((await rows(`select kind from principals where id = '${row.decided_by}'`))[0]!.kind).toBe('system')
    expect(await rows("select id from events where type = 'action_request.expired'")).toHaveLength(1)
  })

  it('scheduled({ cron: "*/15 * * * *" }) runs no rail sweep and the Gmail tick is unchanged', async () => {
    const wk = worker()
    const { body } = await enqueue(wk)
    const overdue = await json(await call(wk, 'POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: 't' }, reason: 'r', expires_at: new Date(now.getTime() + 60_000).toISOString() }))
    advance(3_600_000)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await wk.scheduled({ cron: '*/15 * * * *' })
    expect(await status(body.id)).toBe('queued')
    expect((await rows(`select status from action_requests where id = '${overdue.body.id}'`))[0]!.status).toBe('pending')
    expect(transport.dispatches).toHaveLength(0)
    // The Gmail tick's own line, exactly as before (Gmail is not configured here).
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('[cron] */15 * * * *: Gmail work skipped')])
  })

  it('an unknown expression is logged and does nothing', async () => {
    const wk = worker()
    const { body } = await enqueue(wk)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await wk.scheduled({ cron: '5 4 * * *' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown cron expression "5 4 * * *"'))
    expect(await status(body.id)).toBe('queued')
  })

  it('a database behind its migrations runs neither sweep', async () => {
    const wk = worker()
    const { body } = await enqueue(wk)
    const overdue = await json(await call(wk, 'POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: 't' }, reason: 'r', expires_at: new Date(now.getTime() + 60_000).toISOString() }))
    advance(3_600_000)
    await w.d1.prepare('drop table if exists d1_migrations').run()
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, NAMES.slice(0, -1))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await worker().scheduled({ cron: '* * * * *' })
    expect(await status(body.id)).toBe('queued')
    expect((await rows(`select status from action_requests where id = '${overdue.body.id}'`))[0]!.status).toBe('pending')
    expect(transport.dispatches).toHaveLength(0)
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('behind its migrations')
  })

  it('an uninitialised deployment runs nothing and does not throw', async () => {
    await w.reset()
    await expect(worker().scheduled({ cron: '* * * * *' })).resolves.toBeUndefined()
  })
})

describe('bounded sweeps (CORE47)', () => {
  it('one tick with 100 overdue requests and 5 due executions stays inside the Workers Free limits', async () => {
    const wk = worker()
    const meter = meterD1(w.d1)
    const metered = composeD1Worker({ DB: meter.d1, AUTH_PROVIDER: '' }, { clock: () => now, newId: () => uuidv7(now), operations: registerTestOperations, transports: { [TEST_TRANSPORT]: transport } })
    // A warm isolate: the marker and the migration state are read once on an empty tick, then the loaded tick is measured on its own.
    await metered.scheduled({ cron: '* * * * *' })
    for (let i = 0; i < 5; i++) await enqueue(wk)
    for (let i = 0; i < 100; i++) {
      const r = await json(await call(wk, 'POST', '/api/v1/action-requests', { operation: 'tasks.create', arguments: { title: `t${i}` }, reason: 'r', expires_at: new Date(now.getTime() + 60_000 + i * 1000).toISOString() }))
      expect(r.status).toBe(201)
    }
    advance(200_000) // past every expiry (60 s + i s), inside every execution's ten-minute deadline
    meter.start()
    await metered.scheduled({ cron: '* * * * *' })
    const m = meter.take()
    console.log('MEASURE ' + JSON.stringify({ key: 'rail-tick-100-5', ...m }))
    // Pinned from the first green run (a new round trip is a reviewed change): the deployment marker 1, the expiry sweep 2 (plan read, one write batch), the due list 1,
    // and 4 per execution (claim 1, stamp 1, finish plan read 1, finish batch 1) times 5 = 24. Workers Free allows 50.
    expect(m.queries).toBe(24)
    expect(m.queries).toBeLessThanOrEqual(50)
    expect(m.maxParameters).toBeLessThanOrEqual(100)
    expect(m.maxStatementBytes).toBeLessThanOrEqual(100_000)
    // The tick did its work: 100 expired, the 5 executions run.
    expect((await rows("select count(*) as n from action_requests where status = 'expired'"))[0]!.n).toBe(100)
    expect((await rows("select count(*) as n from action_executions where status = 'done'"))[0]!.n).toBe(5)
  })
})

describe('the test kit never reaches the Worker bundle (D52)', () => {
  it('bundling src/worker.ts leaves out the test operations, the fake transport and the test kit', async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      target: 'es2022',
      external: ['cloudflare:workers'],
      logLevel: 'silent',
    })
    const text = out.outputFiles.map((f) => f.text).join('\n')
    expect(text.length).toBeGreaterThan(100_000)
    for (const marker of ['test.enqueue', 'test-enqueue', 'FakeTransport', 'registerTestOperations', 'test_refused', 'rail-kit']) expect(text, marker).not.toContain(marker)
    // The rail itself is in it.
    expect(text).toContain('action_executions.finish')
  })
})
