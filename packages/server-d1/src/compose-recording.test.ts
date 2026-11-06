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

// [[CHN5]] D78 ([[CHN153]]): the composed Worker's recorder switch and seam, over a local D1 with Google faked at the `fetch` seam.
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


const fake = (gmail: FakeGmail, hosts: string[] = []) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as RequestInfo, init)
  const url = new URL(req.url)
  hosts.push(url.origin)
  if (url.origin === 'https://oauth2.googleapis.com') return google.fetch(`${FAKE_GOOGLE_ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? await req.text() : undefined })
  if (url.origin === 'https://gmail.googleapis.com') return gmail.handle(req, (tok) => google.isAccessToken(tok))
  throw new Error(`no network: ${url.origin}`)
}) as typeof fetch
const msg = (id: string) => gmailFixture('plain', (s) => ({ ...s, id, threadId: `t-${id}`, headers: s.headers.map(([k, v]): [string, string] => [k, k === 'Message-ID' ? `<${id}@acme.test>` : v]), internalDate: Date.now() - 3_600_000 }))
const AHEAD = new Date(NOW.getTime() + 86_400_000).toISOString()
const recordedKeys = (b: { objects: Map<string, Uint8Array> }) => [...b.objects.keys()].filter((k) => k.startsWith('_recordings/') && !k.endsWith('index.json'))
const kindsOf = (keys: string[]) => keys.map((k) => /\/\d{3}-([a-z_]+)-\d+-/.exec(k)![1]!)

async function runSync(extra: Partial<D1WorkerEnv>, opts: { messages?: number; event?: { instanceId?: string; timestamp?: Date } } = {}) {
  const t = await boot()
  const id = await seed(t)
  const gmail = new FakeGmail(Array.from({ length: opts.messages ?? 5 }, (_, i) => msg(`c${i + 1}`)))
  const bucket = fakeR2Bucket()
  const worker = composeD1Worker(env({ BODIES: bucket, ...extra }), { fetch: fake(gmail), streams: nodeStreams(), clock: () => NOW })
  const out = await worker.runMailSync({ payload: { connection_id: id }, ...(opts.event ?? {}) } as never, makeWorkerdStepShim().step)
  const sources = Number((await w.d1.prepare('select count(*) as n from message_sources').first())!.n)
  return { out, sources, bucket, gmail }
}

describe('the switch through the composition', () => {
  for (const [label, value] of [['absent', undefined], ['past', new Date(NOW.getTime() - 1000).toISOString()], ['malformed', 'next tuesday'], ['more than 7 days ahead', new Date(NOW.getTime() + 9 * 86_400_000).toISOString()]] as const) {
    it(`${label}: the run is unchanged and writes no recording`, async () => {
      const lines = logs()
      const r = await runSync(value === undefined ? {} : { GOOGLE_RECORDING_UNTIL: value }, { event: { instanceId: 'inst-1', timestamp: NOW } })
      expect(r.out).toEqual({ end: 'complete', passes: 1 })
      expect(r.sources).toBe(5)
      expect(recordedKeys(r.bucket)).toEqual([])
      expect(r.bucket.calls.some((c) => 'key' in c && c.key.startsWith('_recordings/'))).toBe(false)
      if (label === 'malformed' || label.startsWith('more')) {
        // The composition is built per call here, so the startup line appears; it names the variable and never the value.
        const noted = lines.filter((l) => l.includes('GOOGLE_RECORDING_UNTIL'))
        expect(noted.length).toBeGreaterThan(0)
        expect(noted.join('\n')).not.toContain(String(value))
      } else expect(lines.some((l) => l.includes('GOOGLE_RECORDING_UNTIL'))).toBe(false)
    })
  }
  it('on: a Workflow run records under _recordings/<run start>-<instance id>/, capped per kind, and the result is the same', async () => {
    const r = await runSync({ GOOGLE_RECORDING_UNTIL: AHEAD }, { event: { instanceId: 'inst-77', timestamp: NOW } })
    expect(r.out).toEqual({ end: 'complete', passes: 1 })
    expect(r.sources).toBe(5)
    const keys = recordedKeys(r.bucket)
    expect(keys.every((k) => k.startsWith('_recordings/20261027T100000Z-inst-77/'))).toBe(true)
    const kinds = kindsOf(keys)
    for (const k of ['token_refresh', 'messages_list', 'message_full', 'message_raw']) expect(kinds).toContain(k)
    expect(kinds.filter((k) => k === 'message_full')).toHaveLength(3) // five messages, three recordings
    expect(kinds.filter((k) => k === 'token_refresh').length).toBeLessThanOrEqual(3)
    expect(r.bucket.objects.has('_recordings/index.json')).toBe(true)
    const text = keys.map((k) => new TextDecoder().decode(r.bucket.objects.get(k)!)).join('\n')
    expect(text).not.toContain(google.clientSecret)
    expect(google.refreshTokens.every((t) => !text.includes(t))).toBe(true)
    expect(google.accessTokens.every((t) => !text.includes(t))).toBe(true)
  })
  it('on, without a BODIES bucket: off (the run is refused for the missing bucket as before, nothing is recorded)', async () => {
    const t = await boot()
    const id = await seed(t)
    const worker = composeD1Worker(env({ BODIES: undefined, GOOGLE_RECORDING_UNTIL: AHEAD }), { fetch: fake(new FakeGmail([])), streams: nodeStreams(), clock: () => NOW })
    await expect(worker.runMailSync({ payload: { connection_id: id } }, makeWorkerdStepShim().step)).rejects.toThrow(/BODIES/)
  })
  it('a failing recording write leaves the sync run\'s outcome unchanged and logs', async () => {
    const lines = logs()
    const bucket = fakeR2Bucket()
    const realPut = bucket.put.bind(bucket)
    bucket.put = async (key, value, options) => {
      if (key.startsWith('_recordings/')) throw Object.assign(new Error('r2 down'), { name: 'R2Error' })
      return realPut(key, value, options)
    }
    const t = await boot()
    const id = await seed(t)
    const worker = composeD1Worker(env({ BODIES: bucket, GOOGLE_RECORDING_UNTIL: AHEAD }), { fetch: fake(new FakeGmail([msg('f1'), msg('f2')])), streams: nodeStreams(), clock: () => NOW })
    const out = await worker.runMailSync({ payload: { connection_id: id }, instanceId: 'inst-fail', timestamp: NOW } as never, makeWorkerdStepShim().step)
    expect(out).toEqual({ end: 'complete', passes: 1 })
    expect(Number((await w.d1.prepare('select count(*) as n from message_sources').first())!.n)).toBe(2)
    expect(recordedKeys(bucket)).toEqual([])
    expect(lines.some((l) => l.includes('[recording] write failed') && l.includes('R2Error'))).toBe(true)
  })
  it('step returns stay plain data with the recorder on (workerd boundary shim, invariant 7)', async () => {
    const t = await boot()
    const id = await seed(t)
    const shim = makeWorkerdStepShim()
    const worker = composeD1Worker(env({ BODIES: fakeR2Bucket(), GOOGLE_RECORDING_UNTIL: AHEAD }), { fetch: fake(new FakeGmail([msg('s1')])), streams: nodeStreams(), clock: () => NOW })
    await worker.runMailSync({ payload: { connection_id: id }, instanceId: 'inst-shim', timestamp: NOW } as never, shim.step)
    expect(shim.returns.length).toBeGreaterThan(2)
  })
})
