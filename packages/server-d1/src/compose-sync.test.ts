import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execute, uuidv7 } from '@vault/storage'
import { ScopeSet } from '@vault/api'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { FAKE_GOOGLE_ORIGIN, FakeGoogle } from '@vault/api/test/google'
import { FakeGmail } from '@vault/api/test/gmail'
import { gmailFixture } from '@vault/api/test/gmail-fixtures'
import { seedGmailConnection } from '@vault/api/test/gmail-sync'
import { nodeStreams } from '@vault/api/test/streams'
import { makeWorkerdStepShim } from '@vault/api/test/workerd-boundary'
import { MIGRATIONS, d1Binding } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { readDeployment } from './init-deployment.js'
import { NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// [[CHN141]] D14, D37, D75: the composed Worker's `scheduled` handler and `runMailSync` over a local D1, with Google faked at the `fetch` seam.
const KEY = new Uint8Array(32).fill(7)
const GMAIL_ENV = { GOOGLE_CLIENT_ID: 'fake-client-id.apps.test', GOOGLE_CLIENT_SECRET: 'fake-client-secret', OAUTH_STATE_SECRET: 'state-secret', CREDENTIALS_KEY: Buffer.from(KEY).toString('base64') }
const CRON = '*/15 * * * *'
const BASE = 'https://w.test'

let w: WorkerD1
let google: FakeGoogle
let created: Array<{ id: string; params: { connection_id: string } }>
const binding = { create: async (o: { id: string; params: { connection_id: string } }) => void created.push(o) }
beforeAll(async () => {
  w = await openWorkerD1()
  google = await FakeGoogle.create({ clientId: GMAIL_ENV.GOOGLE_CLIENT_ID, clientSecret: GMAIL_ENV.GOOGLE_CLIENT_SECRET })
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  created = []
})
afterEach(() => vi.restoreAllMocks())

const env = (extra: Partial<D1WorkerEnv> = {}): D1WorkerEnv => ({ DB: w.d1, AUTH_PROVIDER: '', ...GMAIL_ENV, MAIL_SYNC: binding, BODIES: undefined, ...extra })
const logs = () => {
  const lines: string[] = []
  for (const k of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
  return lines
}
async function boot() {
  const res = await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW) })
  const link = (await readDeployment(w.d1))!
  const owner = uuidv7(NOW)
  await w.d1.batch([
    w.d1.prepare('insert into principals (id, kind, created_at) values (?, ?, ?)').bind(owner, 'user', NOW.toISOString()),
    w.d1.prepare('insert into users (id, created_at, updated_at, email, email_verified) values (?, ?, ?, ?, 0)').bind(owner, NOW.toISOString(), NOW.toISOString(), 'owner@w.test'),
  ])
  const b = d1Binding(w.d1, link)
  const env0 = { actor: { id: owner, kind: 'user' as const }, organizationId: link.organizationId, scopes: ScopeSet.parse([]), now: NOW, newId: () => uuidv7(NOW), randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) }
  return { key: res.key, owner, target: { env: () => env0, run: (op: never) => execute(b, { kind: 'tenant', actorId: owner, organizationId: link.organizationId }, op), d1: w.d1 } }
}
const seed = (t: Awaited<ReturnType<typeof boot>>, refreshToken = google.issueRefreshToken()) => seedGmailConnection(t.target as never, { key: KEY, refreshToken, historyId: '1000', lastSyncedAt: null })
const tracker = async (names: readonly string[]) => {
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, names)
}

describe('the scheduled handler (D14, D37, D75)', () => {
  it('*/15 requests a sync for each due active connection', async () => {
    const t = await boot()
    const id = await seed(t)
    await composeD1Worker(env()).scheduled({ cron: CRON, scheduledTime: NOW.getTime() })
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ connection_id: id })
  })
  it('an unknown cron expression is logged, not thrown', async () => {
    const t = await boot()
    await seed(t)
    const lines = logs()
    await expect(composeD1Worker(env()).scheduled({ cron: '0 0 1 1 *', scheduledTime: 0 })).resolves.toBeUndefined()
    expect(created).toEqual([])
    expect(lines.some((l) => l.includes('unknown cron') && l.includes('0 0 1 1 *'))).toBe(true)
  })
  it('skips Gmail work, with a log line, when Gmail is unconfigured or the MAIL_SYNC binding is missing', async () => {
    const t = await boot()
    await seed(t)
    const lines = logs()
    await composeD1Worker(env({ GOOGLE_CLIENT_ID: undefined })).scheduled({ cron: CRON, scheduledTime: 0 })
    await composeD1Worker(env({ MAIL_SYNC: undefined })).scheduled({ cron: CRON, scheduledTime: 0 })
    expect(created).toEqual([])
    expect(lines.filter((l) => /skipped/.test(l) && l.includes(CRON))).toHaveLength(2)
  })
  it('does nothing while the database is behind its migrations (D37) and before the deployment is initialised', async () => {
    const lines = logs()
    await composeD1Worker(env()).scheduled({ cron: CRON, scheduledTime: 0 }) // no marker: nothing to do, no error
    const t = await boot()
    await seed(t)
    await tracker(MIGRATIONS.map((m) => m.name).slice(0, -1))
    await composeD1Worker(env()).scheduled({ cron: CRON, scheduledTime: 0 })
    expect(created).toEqual([])
    expect(lines.some((l) => /behind/.test(l))).toBe(true)
  })
})

describe('the composed run (runMailSync)', () => {
  const fake = (gmail: FakeGmail) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init)
    const url = new URL(req.url)
    if (url.origin === 'https://oauth2.googleapis.com') return google.fetch(`${FAKE_GOOGLE_ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? await req.text() : undefined })
    if (url.origin === 'https://gmail.googleapis.com') return gmail.handle(req, (tok) => google.isAccessToken(tok))
    throw new Error(`no network: ${url.origin}`)
  }) as typeof fetch
  const msg = (id: string) => gmailFixture('plain', (s) => ({ ...s, id, threadId: `t-${id}`, headers: s.headers.map(([k, v]): [string, string] => [k, k === 'Message-ID' ? `<${id}@acme.test>` : v]), internalDate: Date.now() - 3_600_000 }))

  it('runs a backfill to completion through the composition (gate, config, token, pages, R2 stand-in)', async () => {
    const t = await boot()
    const refresh = google.issueRefreshToken()
    const id = await seed(t, refresh)
    const gmail = new FakeGmail([msg('c1'), msg('c2')])
    const worker = composeD1Worker(env({ BODIES: fakeR2Bucket() }), { fetch: fake(gmail), streams: nodeStreams() })
    const shim = makeWorkerdStepShim()
    const out = await worker.runMailSync({ payload: { connection_id: id } }, shim.step)
    expect(out).toEqual({ end: 'complete', passes: 1 })
    expect((await w.d1.prepare('select count(*) as n from message_sources').first())!.n).toBe(2)
  })
  it('throws retryably while the database is behind, and writes nothing', async () => {
    const t = await boot()
    const id = await seed(t)
    await tracker(MIGRATIONS.map((m) => m.name).slice(0, -1))
    const worker = composeD1Worker(env({ BODIES: fakeR2Bucket() }), { fetch: fake(new FakeGmail([])), streams: nodeStreams() })
    await expect(worker.runMailSync({ payload: { connection_id: id } }, makeWorkerdStepShim().step)).rejects.toThrow(/behind/)
    expect((await w.d1.prepare('select run_id from mail_sync_state').first())!.run_id).toBeNull()
  })
  it('a step that finds Gmail unconfigured throws to the retry policy', async () => {
    const t = await boot()
    const id = await seed(t)
    const worker = composeD1Worker(env({ GOOGLE_CLIENT_ID: undefined, BODIES: fakeR2Bucket() }))
    await expect(worker.runMailSync({ payload: { connection_id: id } }, makeWorkerdStepShim().step)).rejects.toThrow(/not configured/)
  })
})

describe('connections.sync through the composed Worker', () => {
  it('an agent key is refused 403 (the e2e check), with no instance created', async () => {
    const t = await boot()
    const id = await seed(t)
    const res = await composeD1Worker(env()).fetch(new Request(`${BASE}/meta/v1/connections/${id}/sync`, { method: 'POST', headers: { authorization: `Bearer ${t.key}` } }))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope')
    expect(created).toEqual([])
  })
})
