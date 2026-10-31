import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { MIGRATIONS, type D1Like } from '@vault/storage-d1'
import { createMigrationTracker, forgetMigrations, openLocalD1, recordMigrations, type LocalD1 } from '@vault/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, openWorkerD1, spyD1, type WorkerD1 } from './test/kit.js'

const NAMES = MIGRATIONS.map((m) => m.name)
const LAST = NAMES[NAMES.length - 1]!
const BASE = 'https://w.test'
const PENDING = { error: { code: 'migrations_pending', message: 'apply the database migrations first' } }

let w: WorkerD1
beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
})

const get = (worker: { fetch(r: Request): Promise<Response> }, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(BASE + path, { headers }))
const boot = () => bootstrapD1(w.d1, { organizationName: 'Acme', email: 'owner@x.test', agentName: 'bot', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW) })
const env = (extra: Partial<D1WorkerEnv> = {}): D1WorkerEnv => ({ DB: w.d1, AUTH_PROVIDER: '', ...extra })
const tracker = async (names: readonly string[]) => {
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, names)
}
const health = async (worker: { fetch(r: Request): Promise<Response> }) => {
  const res = await get(worker, '/health')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('/health.migrations (D3)', () => {
  it('unknown: no tracker, applied 0, latest_applied null', async () => {
    const { status, body } = await health(composeD1Worker(env()))
    expect(status).toBe(200)
    expect(body.migrations).toEqual({ status: 'unknown', applied: 0, expected: NAMES.length, latest_applied: null, latest_expected: LAST })
  })
  it('current', async () => {
    await tracker(NAMES)
    const { body } = await health(composeD1Worker(env()))
    expect(body.migrations).toEqual({ status: 'current', applied: NAMES.length, expected: NAMES.length, latest_applied: LAST, latest_expected: LAST })
    expect(Object.keys(body.migrations as object).sort()).toEqual(['applied', 'expected', 'latest_applied', 'latest_expected', 'status'])
  })
  it('behind', async () => {
    await tracker(NAMES.slice(0, -1))
    const { body } = await health(composeD1Worker(env()))
    expect(body.migrations).toEqual({ status: 'behind', applied: NAMES.length - 1, expected: NAMES.length, latest_applied: NAMES[NAMES.length - 2], latest_expected: LAST })
  })
  it('ahead', async () => {
    await tracker([...NAMES, '9999_future.sql'])
    const { body } = await health(composeD1Worker(env()))
    expect(body.migrations).toEqual({ status: 'ahead', applied: NAMES.length + 1, expected: NAMES.length, latest_applied: '9999_future.sql', latest_expected: LAST })
  })
  it('keeps the existing keys', async () => {
    await tracker(NAMES)
    const { body } = await health(composeD1Worker(env({ VERSION: 'abc' })))
    expect(body).toMatchObject({ status: 'ok', initialised: false, version: 'abc' })
  })
  it('an unreachable database is still 503 unavailable', async () => {
    const spy = spyD1(w.d1, { failSelectOne: () => true })
    const res = await get(composeD1Worker(env({ DB: spy.d1 })), '/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'unavailable' })
  })
})

describe('the behind gate (D4)', () => {
  it('behind and the marker absent: 503 migrations_pending, not not_initialised', async () => {
    await tracker(NAMES.slice(0, -1))
    const res = await get(composeD1Worker(env()), '/tasks', { authorization: 'Bearer vk_x' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(PENDING)
  })
  it('behind and a broken auth configuration: 503 migrations_pending, not 500', async () => {
    await tracker(NAMES.slice(0, -1))
    const res = await get(composeD1Worker(env({ AUTH_PROVIDER: 'clerk' })), '/tasks')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(PENDING)
  })
  it('behind and initialised: every route but /health and /openapi.json is refused, and no unit runs', async () => {
    const r = await boot()
    await tracker(NAMES.slice(0, -1))
    const spy = spyD1(w.d1)
    const worker = composeD1Worker(env({ DB: spy.d1 }))
    for (const [method, path] of [['GET', '/tasks'], ['POST', '/tasks'], ['POST', '/webhooks/clerk']] as const) {
      const res = await worker.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${r.key}` }, body: method === 'POST' ? '{}' : undefined }))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual(PENDING)
    }
    expect(spy.log.statements.filter((s) => /^\s*(insert|update|delete)/i.test(s))).toEqual([])
    expect((await get(worker, '/health')).status).toBe(200)
    const spec = await get(worker, '/openapi.json')
    expect(spec.status).toBe(200)
    expect(((await spec.json()) as { openapi: string }).openapi).toBe('3.1.0')
  })
  it.each([
    ['ahead', [...NAMES, '9999_future.sql'] as string[] | null],
    ['unknown', null],
    ['current', NAMES as string[] | null],
  ])('%s serves normally', async (_n, names) => {
    const r = await boot()
    if (names) await tracker(names)
    const res = await get(composeD1Worker(env()), '/tasks', { authorization: `Bearer ${r.key}` })
    expect(res.status).toBe(200)
  })
})

describe('a database with no marker table and no tracker (edge)', () => {
  let fresh: LocalD1
  let d1: D1Like
  beforeAll(async () => {
    fresh = await openLocalD1(['F'], { migrate: false })
    d1 = fresh.bindings.F!
  })
  afterAll(() => fresh.dispose())

  it('/health is 200 initialised false and unknown', async () => {
    const { status, body } = await health(composeD1Worker({ DB: d1, AUTH_PROVIDER: '' }))
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'ok', initialised: false, version: 'dev', migrations: { status: 'unknown', applied: 0, expected: NAMES.length, latest_applied: null, latest_expected: LAST } })
  })
  it('other routes are 503 not_initialised, openapi still served', async () => {
    const worker = composeD1Worker({ DB: d1, AUTH_PROVIDER: '' })
    const res = await get(worker, '/tasks', { authorization: 'Bearer vk_x' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_initialised')
    expect((await get(worker, '/openapi.json')).status).toBe(200)
  })
})

describe('the per-isolate cache (D6)', () => {
  const reads = (statements: string[]) => statements.filter((s) => /from d1_migrations/i.test(s)).length
  let t = 1_000_000
  const clock = () => t

  it('behind clears within the re-read window after rows are inserted, and is not re-read before it', async () => {
    await tracker(NAMES.slice(0, -1))
    const spy = spyD1(w.d1)
    const r = await boot()
    t = 1_000_000
    const worker = composeD1Worker(env({ DB: spy.d1 }), { nowMs: clock })
    const auth = { authorization: `Bearer ${r.key}` }
    expect((await get(worker, '/tasks', auth)).status).toBe(503)
    await recordMigrations(w.d1, [LAST])
    t += 4_000
    expect((await get(worker, '/tasks', auth)).status).toBe(503)
    expect(reads(spy.log.statements)).toBe(1)
    t += 1_000
    expect((await get(worker, '/tasks', auth)).status).toBe(200)
    expect(reads(spy.log.statements)).toBe(2)
  })
  it('current is read once and never again', async () => {
    await tracker(NAMES)
    const spy = spyD1(w.d1)
    t = 2_000_000
    const worker = composeD1Worker(env({ DB: spy.d1 }), { nowMs: clock })
    for (let i = 0; i < 3; i++) {
      await get(worker, '/health')
      t += 60_000
    }
    expect(reads(spy.log.statements)).toBe(1)
  })
  it('ahead is cached like current', async () => {
    await tracker([...NAMES, '9999_future.sql'])
    const spy = spyD1(w.d1)
    t = 3_000_000
    const worker = composeD1Worker(env({ DB: spy.d1 }), { nowMs: clock })
    await get(worker, '/health')
    t += 60_000
    await forgetMigrations(w.d1, ['9999_future.sql'])
    await get(worker, '/health')
    expect(reads(spy.log.statements)).toBe(1)
  })
  it('unknown from a missing tracker is re-read only after the window', async () => {
    const spy = spyD1(w.d1)
    t = 4_000_000
    const worker = composeD1Worker(env({ DB: spy.d1 }), { nowMs: clock })
    await get(worker, '/health')
    t += 1_000
    await get(worker, '/health')
    expect(reads(spy.log.statements)).toBe(1)
    await tracker(NAMES)
    t += 4_000
    const { body } = await health(worker)
    expect((body.migrations as { status: string }).status).toBe('current')
  })
  it('a read that throws is not remembered: the next request reads again', async () => {
    await tracker(NAMES.slice(0, -1))
    let fail = true
    let count = 0
    const flaky: D1Like = {
      prepare(q) {
        if (/from d1_migrations/i.test(q)) {
          count++
          if (fail) throw new Error('D1 hiccup')
        }
        return w.d1.prepare(q)
      },
      batch: (b) => w.d1.batch(b),
    }
    t = 5_000_000
    const worker = composeD1Worker(env({ DB: flaky }), { nowMs: clock })
    expect(((await health(worker)).body.migrations as { status: string }).status).toBe('unknown')
    fail = false
    expect(((await health(worker)).body.migrations as { status: string }).status).toBe('behind')
    expect(count).toBe(2)
  })
})
