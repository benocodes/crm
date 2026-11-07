import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execute, uuidv7 } from '@vault/storage'
import { ScopeSet } from '@vault/api'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { FAKE_GOOGLE_ORIGIN, FakeGoogle } from '@vault/api/test/google'
import { FakeGmail } from '@vault/api/test/gmail'
import { seedGmailConnection } from '@vault/api/test/gmail-sync'
import { MIGRATIONS, d1Binding } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { readDeployment } from './init-deployment.js'
import { NOW, openWorkerD1, type WorkerD1 } from './test/kit.js'

// [[CHN155]] / [[CHN5]] D87, D89, D92: the composed Worker's push gate, the cron's watch renewal and the recorder's run name, over a local D1 with Google faked at the `fetch` seam.
const KEY = new Uint8Array(32).fill(7)
const GMAIL_ENV = { GOOGLE_CLIENT_ID: 'fake-client-id.apps.test', GOOGLE_CLIENT_SECRET: 'fake-client-secret', OAUTH_STATE_SECRET: 'state-secret', CREDENTIALS_KEY: Buffer.from(KEY).toString('base64') }
const PUSH_ENV = { GMAIL_TOPIC_NAME: 'projects/p/topics/gmail.watch', GMAIL_PUSH_SUBSCRIPTION: 'projects/p/subscriptions/gmail.push', GMAIL_PUSH_SERVICE_ACCOUNT: 'push@p.iam.gserviceaccount.com', PUBLIC_BASE_URL: 'https://w.test' }
const CRON = '*/15 * * * *'
const BASE = 'https://w.test'
const AHEAD = new Date(NOW.getTime() + 86_400_000).toISOString()

let w: WorkerD1
let google: FakeGoogle
let created: Array<{ id: string; params: { connection_id: string } }>
const binding = { create: async (o: { id: string; params: { connection_id: string } }) => void created.push(o) }
beforeAll(async () => {
  w = await openWorkerD1()
  google = await FakeGoogle.create({ clientId: GMAIL_ENV.GOOGLE_CLIENT_ID, clientSecret: GMAIL_ENV.GOOGLE_CLIENT_SECRET })
}, 30_000) // Starting workerd and applying migrations can exceed the default 10 s under suite load.
afterAll(() => w?.dispose())
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
  await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme' }, { now: NOW, newId: () => uuidv7(NOW) })
  const link = (await readDeployment(w.d1))!
  const owner = uuidv7(NOW)
  await w.d1.batch([
    w.d1.prepare('insert into principals (id, kind, created_at) values (?, ?, ?)').bind(owner, 'user', NOW.toISOString()),
    w.d1.prepare('insert into users (id, created_at, updated_at, email, email_verified) values (?, ?, ?, ?, 0)').bind(owner, NOW.toISOString(), NOW.toISOString(), 'owner@w.test'),
  ])
  const b = d1Binding(w.d1, link)
  const env0 = { actor: { id: owner, kind: 'user' as const }, organizationId: link.organizationId, scopes: ScopeSet.parse([]), now: NOW, newId: () => uuidv7(NOW), randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) }
  return { owner, target: { env: () => env0, run: (op: never) => execute(b, { kind: 'tenant', actorId: owner, organizationId: link.organizationId }, op), d1: w.d1 } }
}
const seed = (t: Awaited<ReturnType<typeof boot>>) => seedGmailConnection(t.target as never, { key: KEY, refreshToken: google.issueRefreshToken(), historyId: '1000', lastSyncedAt: null })
const fake = (gmail: FakeGmail, jwksCalls: string[] = []) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as RequestInfo, init)
  const url = new URL(req.url)
  if (url.origin === 'https://oauth2.googleapis.com') return google.fetch(`${FAKE_GOOGLE_ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? await req.text() : undefined })
  if (url.origin === 'https://gmail.googleapis.com') return gmail.handle(req, (tok) => google.isAccessToken(tok))
  if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') {
    jwksCalls.push(url.href)
    return google.fetch(`${FAKE_GOOGLE_ORIGIN}${url.pathname}`)
  }
  throw new Error(`no network: ${url.origin}`)
}) as typeof fetch
const watches = async () => (await w.d1.prepare('select * from gmail_watches').all()).results as Array<Record<string, unknown>>
const tick = (extra: Partial<D1WorkerEnv>, gmail: FakeGmail, time = NOW.getTime()) => composeD1Worker(env(extra), { fetch: fake(gmail), clock: () => new Date(time) }).scheduled({ cron: CRON, scheduledTime: time })
const watchCalls = (g: FakeGmail) => g.calls.filter((c) => c.op === 'watch').length

describe('the cron with push on (D89)', () => {
  it('registers a watch for a live connection that has none, and still requests the sync', async () => {
    const t = await boot()
    const id = await seed(t)
    const gmail = new FakeGmail()
    gmail.watchClock = () => NOW.getTime()
    await tick(PUSH_ENV, gmail)
    expect(watchCalls(gmail)).toBe(1)
    expect(gmail.watchRequests[0]).toEqual({ topicName: PUSH_ENV.GMAIL_TOPIC_NAME, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' })
    expect(await watches()).toEqual([expect.objectContaining({ connection_id: id, expires_at: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() })])
    expect(created.map((c) => c.params.connection_id)).toEqual([id])
  })
  it.each([[{ GMAIL_TOPIC_NAME: undefined }], [{ GMAIL_PUSH_SUBSCRIPTION: undefined }], [{ GMAIL_PUSH_SERVICE_ACCOUNT: undefined }], [{ PUBLIC_BASE_URL: undefined }], [{ MAIL_SYNC: undefined }], [{}]] as const)('push off (%j): the cron makes no watch call and writes no row', async (missing) => {
    const t = await boot()
    await seed(t)
    const gmail = new FakeGmail()
    const vars = missing && Object.keys(missing).length > 0 ? { ...PUSH_ENV, ...missing } : {}
    await tick(vars as Partial<D1WorkerEnv>, gmail)
    expect(watchCalls(gmail)).toBe(0)
    expect(await watches()).toEqual([])
  })
  it('a watch that fails does not stop the tick: the sync request is still made and the tick does not throw', async () => {
    const t = await boot()
    const id = await seed(t)
    const gmail = new FakeGmail().failWhen((c) => c.op === 'watch', new (await import('@vault/api')).GmailApiError({ status: 403, reason: 'forbidden' }))
    const lines = logs()
    await expect(tick(PUSH_ENV, gmail)).resolves.toBeUndefined()
    expect(watchCalls(gmail)).toBe(1)
    expect(created.map((c) => c.params.connection_id)).toEqual([id])
    expect(await watches()).toEqual([])
    expect(lines.some((l) => l.includes('misconfigured'))).toBe(true)
  })
  it('records the cron\'s watch under its own run name (cron-<scheduled time>), with no token or topic in the recording', async () => {
    const t = await boot()
    await seed(t)
    const bucket = fakeR2Bucket()
    await tick({ ...PUSH_ENV, BODIES: bucket, GOOGLE_RECORDING_UNTIL: AHEAD }, new FakeGmail())
    const keys = [...bucket.objects.keys()].filter((k) => k.startsWith('_recordings/') && !k.endsWith('index.json'))
    const watchKeys = keys.filter((k) => /\/\d{3}-watch-200-/.test(k))
    expect(watchKeys).toHaveLength(1)
    expect(watchKeys[0]!).toContain(`-cron-${NOW.getTime()}/`)
    const text = keys.map((k) => new TextDecoder().decode(bucket.objects.get(k)!)).join('\n')
    expect(text).not.toContain(PUSH_ENV.GMAIL_TOPIC_NAME)
    expect(google.accessTokens.every((tok) => !text.includes(tok))).toBe(true)
  })
})

describe('POST /gmail/push through the composition', () => {
  const push = (worker: ReturnType<typeof composeD1Worker>, headers: Record<string, string> = {}) => worker.fetch(new Request(`${BASE}/gmail/push`, { method: 'POST', headers, body: '{}' }))
  it('is 404 when push is off, whatever the credentials', async () => {
    await boot()
    expect((await push(composeD1Worker(env()))).status).toBe(404)
    expect((await push(composeD1Worker(env({ ...PUSH_ENV, MAIL_SYNC: undefined })))).status).toBe(404)
  })
  it('with push on and no bearer it is 401 and the JWKS is not fetched; a bearer that is not a JWT neither', async () => {
    await boot()
    const calls: string[] = []
    const worker = composeD1Worker(env(PUSH_ENV), { fetch: fake(new FakeGmail(), calls) })
    expect((await push(worker)).status).toBe(401)
    expect((await push(worker, { authorization: 'Bearer nope' })).status).toBe(401)
    expect(calls).toEqual([])
  })
  it('a database behind its migrations answers 503 migrations_pending first (CORE61 gate, D43)', async () => {
    await boot()
    await createMigrationTracker(w.d1)
    await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name).slice(0, -1))
    const res = await push(composeD1Worker(env(PUSH_ENV)))
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([503, 'migrations_pending'])
  })
})
