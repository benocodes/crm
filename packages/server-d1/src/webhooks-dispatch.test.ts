import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { MIGRATIONS } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'
import { NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// API219 (D6, dispatch half): the per-minute expression runs webhook dispatch after the rail's sweeps, behind the migration gate; the real bundle does it in workerd (`pnpm smoke:worker`).
// Dispatch's own behaviour is proven in @vault/api; here only the composition: the one handler, its order, its gate and its log line.
let w: WorkerD1
let key: string
const BASE = 'https://w.test'
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
const SCOPES = ['webhooks:read', 'webhooks:write', 'events:read', 'tasks:read', 'tasks:write']
const NAMES = MIGRATIONS.map((m) => m.name)
const worker = () => composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '', CREDENTIALS_KEY: KEY }, { clock: () => NOW, newId: () => uuidv7(NOW) })
const call = async (wk: ReturnType<typeof worker>, method: string, path: string, body?: unknown) => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }))
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
const rows = async (sqlText: string) => ((await w.d1.prepare(sqlText).all()).results ?? []) as Array<Record<string, any>>

beforeAll(async () => {
  w = await openWorkerD1()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  key = (await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme', scopes: SCOPES }, { now: NOW, newId: () => uuidv7(NOW) })).key
})
afterEach(() => vi.restoreAllMocks())

describe('the per-minute handler dispatches webhooks after the rail (D6)', () => {
  it('a subscription and a task event produce one pending row after "* * * * *", and its log line follows the rail line', async () => {
    const wk = worker()
    const sub = await call(wk, 'POST', '/meta/v1/webhooks', { url: 'https://example.com/hook', event_types: ['task.created'] })
    expect(sub.status, JSON.stringify(sub.body)).toBe(201)
    expect((await call(wk, 'POST', '/api/v1/tasks', { title: 'cron me' })).status).toBe(201)
    expect(await rows('select id from webhook_deliveries')).toEqual([])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await wk.scheduled({ cron: '* * * * *' })
    const delivered = await rows('select subscription_id, event_type, status, attempts from webhook_deliveries')
    expect(delivered).toEqual([{ subscription_id: sub.body.id, event_type: 'task.created', status: 'pending', attempts: 0 }])
    const lines = log.mock.calls.map((c) => String(c[0]))
    const rail = lines.findIndex((l) => l.includes('rail expired 0 request(s), attempted 0 execution(s)'))
    const hooks = lines.findIndex((l) => l.includes('webhooks dispatched 1 event(s) for 1 subscription(s)'))
    expect(rail, lines.join('\n')).toBeGreaterThanOrEqual(0)
    expect(hooks, lines.join('\n')).toBeGreaterThan(rail)
    await wk.scheduled({ cron: '* * * * *' })
    expect(await rows('select id from webhook_deliveries')).toHaveLength(1)
  })

  it('the 15-minute expression dispatches nothing', async () => {
    const wk = worker()
    await call(wk, 'POST', '/meta/v1/webhooks', { url: 'https://example.com/hook', event_types: ['task.created'] })
    await call(wk, 'POST', '/api/v1/tasks', { title: 'not yet' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await wk.scheduled({ cron: '*/15 * * * *' })
    expect(await rows('select id from webhook_deliveries')).toEqual([])
  })

  it('a database behind its migrations dispatches nothing', async () => {
    const wk = worker()
    await call(wk, 'POST', '/meta/v1/webhooks', { url: 'https://example.com/hook', event_types: ['task.created'] })
    await call(wk, 'POST', '/api/v1/tasks', { title: 'gated' })
    await w.d1.prepare('drop table if exists d1_migrations').run()
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, NAMES.slice(0, -1))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await worker().scheduled({ cron: '* * * * *' })
    expect(await rows('select id from webhook_deliveries')).toEqual([])
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('behind its migrations')
  })

  it('an uninitialised deployment dispatches nothing and does not throw', async () => {
    await w.reset()
    await expect(worker().scheduled({ cron: '* * * * *' })).resolves.toBeUndefined()
  })

  it('no CREDENTIALS_KEY is no obstacle to dispatch (D12 is the sender\'s): rows are written whatever the key', async () => {
    const wk = worker()
    await call(wk, 'POST', '/meta/v1/webhooks', { url: 'https://example.com/hook', event_types: ['task.created'] })
    await call(wk, 'POST', '/api/v1/tasks', { title: 'keyless' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '' }, { clock: () => NOW, newId: () => uuidv7(NOW) }).scheduled({ cron: '* * * * *' })
    expect(await rows('select id from webhook_deliveries')).toHaveLength(1)
  })
})
