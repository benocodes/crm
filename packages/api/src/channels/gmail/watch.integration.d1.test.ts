import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { SCOPE_POLICY } from '../../auth/roles.js'
import { parseGmailConfig, parsePushConfig } from '../../connections/config.js'
import { createApp } from '../../rest/app.js'
import { openD1Engine, type Engine } from '../../test/engines.js'
import { FAKE_ENDPOINTS, FAKE_GMAIL_BASE, FakeGoogle, type FakeAccount } from '../../test/google.js'
import { FakeGmail } from '../../test/gmail.js'
import { seedGmailConnection } from '../../test/gmail-sync.js'
import { PUSH } from '../../test/push.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../../test/user-auth.js'
import { GmailApiError } from './client.js'
import { renewWatches, type WatchDeps } from './watch.js'
import type { MailSyncInstances } from '../../sync/request.js'

// [[CHN155]] / [[CHN5]] D89-D91: the watch at connect, its renewal and its stop on delete, on local D1 against FakeGoogle. Nothing reaches the network.
const KEY = new Uint8Array(32).fill(3)
const ENV = { GOOGLE_CLIENT_ID: 'fake-client-id.apps.test', GOOGLE_CLIENT_SECRET: 'fake-client-secret', OAUTH_STATE_SECRET: 'state-secret-for-tests', CREDENTIALS_KEY: Buffer.from(KEY).toString('base64'), PUBLIC_BASE_URL: PUSH.publicBaseUrl }
const PUSH_ENV = { GMAIL_TOPIC_NAME: PUSH.topicName, GMAIL_PUSH_SUBSCRIPTION: PUSH.subscription, GMAIL_PUSH_SERVICE_ACCOUNT: PUSH.serviceAccount }
const ANN: FakeAccount = { sub: 'sub-ann', email: 'Ann@Example.test', historyId: '555' }
const DAY = 86_400_000
const MIN = 60_000

let e: Engine
let google: FakeGoogle
let now: Date
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: ENV.GOOGLE_CLIENT_ID, clientSecret: ENV.GOOGLE_CLIENT_SECRET })
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date('2026-11-05T10:00:00.000Z')
  google.clock = () => now.getTime()
  google.failWatch(null)
  google.failStop(null)
  google.watchRequests.length = 0
  google.stopRequests.length = 0
})
afterEach(() => vi.restoreAllMocks())

const instances: MailSyncInstances = { create: async () => {} }
const buildApp = (env: Record<string, string | undefined> = { ...ENV, ...PUSH_ENV }) => {
  const { config } = parseGmailConfig(env)
  const { config: push } = parsePushConfig(env)
  return createApp({
    storage: () => e.binding,
    userAuthenticator: fakeUserAuthenticator(),
    clock: () => now,
    newId: () => uuidv7(now),
    gmail: { config, push, instances, endpoints: FAKE_ENDPOINTS, fetch: google.fetch, gmailBaseUrl: FAKE_GMAIL_BASE, policy: SCOPE_POLICY, roleOf: async () => 'owner' },
  })
}
const token = (scopes: string[]) => mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes, kind: 'user' })
async function connect(app: ReturnType<typeof buildApp>, account: FakeAccount = ANN): Promise<Response> {
  const res = await app.request('https://vault.test/meta/v1/connections/authorize', { method: 'POST', headers: { authorization: `Bearer ${token(['connections:write'])}`, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }) })
  const { authorize_url } = (await res.json()) as { authorize_url: string }
  return app.request(await google.consent(authorize_url, account))
}
const eventTypes = async () => (await e.rows('events')).map((r) => r.type as string).sort()

describe('the watch at connect (D89)', () => {
  it('registers the watch for INBOX and SENT before the unit and writes the row in it: lowercase mailbox, expires_at from Google\'s expiration, no extra event', async () => {
    const res = await connect(buildApp())
    expect(res.status).toBe(200)
    expect(google.watchRequests).toHaveLength(1)
    expect(google.watchRequests[0]!.body).toEqual({ topicName: PUSH.topicName, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' })
    expect(google.isAccessToken(google.watchRequests[0]!.token)).toBe(true)
    const conn = (await e.rows('channel_connections'))[0]!
    expect(await e.rows('gmail_watches')).toEqual([expect.objectContaining({ connection_id: conn.id, mailbox: 'ann@example.test', expires_at: new Date(now.getTime() + 7 * DAY).toISOString(), created_by: e.userId })])
    expect(await eventTypes()).toEqual(['connection.created', 'identity.created'])
    // The cursor still comes from the profile's history id, not the watch's.
    expect((await e.rows('mail_sync_cursors'))[0]).toMatchObject({ history_id: '555' })
  })
  it('a watch failure never refuses the connect: the connection commits with no row, and says so in the log by class, not by value', async () => {
    const warn: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...a) => void warn.push(a.join(' ')))
    google.failWatch({ status: 403, reason: 'forbidden' })
    const res = await connect(buildApp())
    expect(res.status).toBe(200)
    expect(await e.rows('channel_connections')).toHaveLength(1)
    expect(await e.rows('gmail_watches')).toEqual([])
    expect(await eventTypes()).toEqual(['connection.created', 'identity.created'])
    const line = warn.find((l) => l.includes('watch'))!
    expect(line).toContain('misconfigured')
    for (const secret of [PUSH.topicName, 'ann@example.test', ...google.accessTokens]) expect(warn.join('\n')).not.toContain(secret)
  })
  it('a reconnect upserts: still one row, with the new expiration', async () => {
    const app = buildApp()
    await connect(app)
    now = new Date(now.getTime() + 3 * DAY)
    await connect(app)
    const watches = await e.rows('gmail_watches')
    expect(watches).toHaveLength(1)
    expect(watches[0]!.expires_at).toBe(new Date(now.getTime() + 7 * DAY).toISOString())
    expect(google.watchRequests).toHaveLength(2)
  })
  it('a reconnect whose watch fails keeps the connection and the row it had', async () => {
    const app = buildApp()
    await connect(app)
    const first = (await e.rows('gmail_watches'))[0]!.expires_at
    now = new Date(now.getTime() + 3 * DAY)
    google.failWatch({ status: 500 })
    expect((await connect(app)).status).toBe(200)
    expect((await e.rows('gmail_watches'))[0]!.expires_at).toBe(first)
  })
  it('with push off no watch is requested and no row is written', async () => {
    expect((await connect(buildApp({ ...ENV }))).status).toBe(200)
    expect(google.watchRequests).toEqual([])
    expect(await e.rows('gmail_watches')).toEqual([])
  })
})

describe('renewal (D89, D90)', () => {
  let n = 0
  const seed = async (opts: { expiresIn?: number | null; status?: string } = {}) => {
    n++
    const rt = google.issueRefreshToken()
    const id = await seedGmailConnection(e, { key: KEY, refreshToken: rt, sub: `sub-r${n}`, mailbox: `Box${n}@Vault.test`, lastSyncedAt: null })
    if (opts.expiresIn !== null) await e.insert('gmail_watches', { connection_id: id, mailbox: `box${n}@vault.test`, expires_at: new Date(now.getTime() + (opts.expiresIn ?? 7 * DAY)).toISOString() })
    if (opts.status) await e.d1!.prepare('update channel_connections set status = ? where id = ?').bind(opts.status, id).run()
    return { id, rt }
  }
  const deps = (over: Partial<WatchDeps> = {}): WatchDeps => ({
    binding: e.binding,
    organizationId: e.organizationId,
    clock: () => now,
    newId: () => uuidv7(now),
    randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
    config: { clientId: ENV.GOOGLE_CLIENT_ID, clientSecret: ENV.GOOGLE_CLIENT_SECRET, credentialsKey: KEY, keyVersion: 1 },
    topicName: PUSH.topicName,
    endpoints: FAKE_ENDPOINTS,
    fetch: google.fetch,
    gmailBaseUrl: FAKE_GMAIL_BASE,
    ...over,
  })
  const watchRow = async (id: string) => (await e.rows('gmail_watches')).find((r) => r.connection_id === id)
  beforeEach(() => google.signedInAs({ sub: 'x', email: 'x@vault.test', historyId: '900' }))

  it('a connection with no row gets a watch, with the mailbox from its own identity, lowercase', async () => {
    const a = await seed({ expiresIn: null })
    const out = await renewWatches(deps())
    expect(out).toMatchObject({ attempted: 1, registered: 1 })
    expect(await watchRow(a.id)).toMatchObject({ mailbox: 'box1@vault.test', expires_at: new Date(now.getTime() + 7 * DAY).toISOString(), created_by: e.userId })
    expect(google.watchRequests).toHaveLength(1)
  })
  it('6 days and a minute left: no call. 6 days less a minute: renewed with expires_at updated', async () => {
    const keep = await seed({ expiresIn: 6 * DAY + MIN })
    const renew = await seed({ expiresIn: 6 * DAY - MIN })
    const before = (await watchRow(keep.id))!.expires_at
    const out = await renewWatches(deps())
    expect(out).toMatchObject({ attempted: 1, registered: 1 })
    expect(google.watchRequests).toHaveLength(1)
    expect((await watchRow(keep.id))!.expires_at).toBe(before)
    expect((await watchRow(renew.id))!.expires_at).toBe(new Date(now.getTime() + 7 * DAY).toISOString())
  })
  it('an inactive (reauth_required, suspended) or deleted connection is not renewed', async () => {
    await seed({ expiresIn: null, status: 'reauth_required' })
    await seed({ expiresIn: null, status: 'suspended' })
    const gone = await seed({ expiresIn: null })
    await e.d1!.prepare('update channel_connections set deleted_at = ? where id = ?').bind(now.toISOString(), gone.id).run()
    expect(await renewWatches(deps())).toMatchObject({ attempted: 0, registered: 0 })
    expect(google.watchRequests).toEqual([])
    expect(await e.rows('gmail_watches')).toEqual([])
  })
  it.each([
    [{ status: 429 }, 'throttled'],
    [{ status: 403, reason: 'rateLimitExceeded' }, 'throttled'],
    [{ status: 403, reason: 'userRateLimitExceeded' }, 'throttled'],
    [{ status: 403, reason: 'forbidden' }, 'misconfigured'],
    [{ status: 400, reason: 'invalidArgument' }, 'misconfigured'],
    [{ status: 404 }, 'misconfigured'],
    [{ status: 500 }, 'failed'],
    [{ status: 503 }, 'failed'],
  ] as const)('one connection failing with %j is %s: the others are renewed and it is called once in the tick', async (failure, klass) => {
    const warn: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...a) => void warn.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a) => void warn.push(a.join(' ')))
    const bad = await seed({ expiresIn: null })
    const ok1 = await seed({ expiresIn: null })
    const ok2 = await seed({ expiresIn: 1 * DAY })
    google.failWatch({ ...failure, forRefreshToken: bad.rt })
    const out = await renewWatches(deps())
    expect(out).toMatchObject({ attempted: 3, registered: 2, failed: { [klass]: 1 } })
    expect(await watchRow(bad.id)).toBeUndefined()
    expect((await watchRow(ok1.id))!.expires_at).toBe(new Date(now.getTime() + 7 * DAY).toISOString())
    expect((await watchRow(ok2.id))!.expires_at).toBe(new Date(now.getTime() + 7 * DAY).toISOString())
    expect(google.watchRequests).toHaveLength(3)
    const logged = warn.find((l) => l.includes(bad.id))!
    expect(logged).toContain(klass)
    expect(logged).toContain(String(failure.status))
    for (const secret of [PUSH.topicName, 'box1@vault.test', ...google.accessTokens, bad.rt]) expect(warn.join('\n')).not.toContain(secret)
    expect(await eventTypes()).not.toContain('connection.updated')
  })
  it('a failing connection keeps the row it had', async () => {
    const bad = await seed({ expiresIn: 1 * DAY })
    const before = (await watchRow(bad.id))!.expires_at
    google.failWatch({ status: 500, forRefreshToken: bad.rt })
    await renewWatches(deps())
    expect((await watchRow(bad.id))!.expires_at).toBe(before)
  })
  it('invalid_grant moves the connection to reauth_required with one connection.updated and no watch, and the others still renew', async () => {
    const revoked = await seed({ expiresIn: null })
    const ok = await seed({ expiresIn: null })
    google.revoke(revoked.rt)
    const eventsBefore = (await e.rows('events')).length
    const out = await renewWatches(deps())
    expect(out).toMatchObject({ attempted: 2, registered: 1, failed: { reauth_required: 1 } })
    expect((await e.rows('channel_connections')).find((r) => r.id === revoked.id)).toMatchObject({ status: 'reauth_required' })
    expect(await watchRow(revoked.id)).toBeUndefined()
    expect(await watchRow(ok.id)).toBeDefined()
    const events = (await e.rows('events')).slice(eventsBefore)
    expect(events.map((x) => x.type)).toEqual(['connection.updated'])
    expect(events[0]!.resource_id).toBe(revoked.id)
    // A second tick: the connection is no longer active, so nothing more is written or emitted.
    await renewWatches(deps())
    expect((await e.rows('events')).length).toBe(eventsBefore + 1)
  })
  it('a row inserted between the read and the write (drift) is upserted, not a unique-violation', async () => {
    const a = await seed({ expiresIn: null })
    const fake = new FakeGmail()
    fake.watchClock = () => now.getTime()
    const racing = {
      ...fake,
      watch: async (p: { topicName: string }) => {
        await e.insert('gmail_watches', { connection_id: a.id, mailbox: 'box1@vault.test', expires_at: '2026-11-06T00:00:00.000Z' })
        return fake.watch(p)
      },
    }
    const out = await renewWatches(deps({ clientFor: () => racing as never }))
    expect(out).toMatchObject({ attempted: 1, registered: 1 })
    expect((await e.rows('gmail_watches')).filter((r) => r.connection_id === a.id)).toHaveLength(1)
    expect((await watchRow(a.id))!.expires_at).toBe(new Date(now.getTime() + 7 * DAY).toISOString())
  })
  it('a GmailApiError thrown by a client is classified the same way (clientFor seam)', async () => {
    await seed({ expiresIn: null })
    const fake = new FakeGmail().failWhen((c) => c.op === 'watch', new GmailApiError({ status: 429 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await renewWatches(deps({ clientFor: () => fake }))).toMatchObject({ failed: { throttled: 1 } })
  })
  it('emits no event when it renews, and writes only gmail_watches', async () => {
    await seed({ expiresIn: null })
    const eventsBefore = (await e.rows('events')).length
    const stateBefore = JSON.stringify(await e.rows('mail_sync_state'))
    await renewWatches(deps())
    expect((await e.rows('events')).length).toBe(eventsBefore)
    expect(JSON.stringify(await e.rows('mail_sync_state'))).toBe(stateBefore)
  })
})

describe('stop on delete (D91)', () => {
  const del = (app: ReturnType<typeof buildApp>, id: string) => app.request(`https://vault.test/meta/v1/connections/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token(['connections:write'])}` } })
  const connectedId = async (app: ReturnType<typeof buildApp>) => {
    expect((await connect(app)).status).toBe(200)
    return String((await e.rows('channel_connections'))[0]!.id)
  }
  it('calls users.stop once after the unit commits, with an access token refreshed from the deleted credential', async () => {
    const app = buildApp()
    const id = await connectedId(app)
    const refresh = google.refreshTokens.at(-1)!
    expect((await del(app, id)).status).toBe(204)
    expect(google.stopRequests).toHaveLength(1)
    expect(google.isAccessToken(google.stopRequests[0]!.token)).toBe(true)
    expect(google.refreshRequests.at(-1)!.refresh_token).toBe(refresh)
    expect(await e.rows('gmail_watches')).toEqual([])
    expect(await e.rows('channel_credentials')).toEqual([])
    expect(await eventTypes()).toContain('connection.deleted')
  })
  it('a failing stop leaves the delete response and its rows unchanged', async () => {
    const app = buildApp()
    const id = await connectedId(app)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    google.failStop(500)
    expect((await del(app, id)).status).toBe(204)
    expect(google.stopRequests).toHaveLength(1)
    expect((await e.rows('channel_connections'))[0]).toMatchObject({ id })
    expect((await e.rows('channel_connections'))[0]!.deleted_at).not.toBeNull()
    expect(await e.rows('gmail_watches')).toEqual([])
    expect(await e.rows('channel_credentials')).toEqual([])
  })
  it('a refresh that fails (the grant was revoked) is logged and the delete still answers 204', async () => {
    const app = buildApp()
    const id = await connectedId(app)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    google.revoke(google.refreshTokens.at(-1)!)
    expect((await del(app, id)).status).toBe(204)
    expect(google.stopRequests).toEqual([])
  })
  it('a connection with no watch row makes no call', async () => {
    const app = buildApp()
    const id = await connectedId(app)
    await e.d1!.prepare('delete from gmail_watches').run()
    expect((await del(app, id)).status).toBe(204)
    expect(google.stopRequests).toEqual([])
  })
  it('with push off no call is made even when a watch row exists', async () => {
    const app = buildApp()
    const id = await connectedId(app)
    expect((await del(buildApp({ ...ENV }), id)).status).toBe(204)
    expect(google.stopRequests).toEqual([])
  })
  it('a unit that does not commit makes no call: a drift between plan and commit is 409 and the connection is untouched', async () => {
    const app = buildApp()
    const id = await connectedId(app)
    e.betweenPlanAndCommit(async () => {
      await e.d1!.prepare("update channel_connections set updated_at = '2026-11-05T10:00:01.000Z' where id = ?").bind(id).run()
    })
    expect((await del(app, id)).status).toBe(409)
    expect(google.stopRequests).toEqual([])
    expect((await e.rows('channel_connections'))[0]!.deleted_at).toBeNull()
    // Not asserted: the machinery rows. The generated delete's `after` statements are not guarded by the delete's own success, so a drifted delete (409) still removes them
    // (found by this test; pre-existing and reported in RESULT.md, not changed here).
  })
  it('deleting an unknown connection is 404 and makes no call', async () => {
    expect((await del(buildApp(), uuidv7(now))).status).toBe(404)
    expect(google.stopRequests).toEqual([])
  })
})
