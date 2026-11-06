import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { uuidv7 } from '@vault/storage'
import { parseGmailConfig, parsePushConfig } from '../../connections/config.js'
import { createApp } from '../../rest/app.js'
import { dueConnections, type MailSyncInstances, type MailSyncParams } from '../../sync/request.js'
import { finishPass } from '../../sync/lease.js'
import { openD1Engine, type Engine } from '../../test/engines.js'
import { seedGmailConnection } from '../../test/gmail-sync.js'
import { PUSH, jwksFetch, newPushKey, pushBody, signPushToken, type PushClaims, type PushKey } from '../../test/push.js'
import { fakeUserAuthenticator } from '../../test/user-auth.js'

// [[CHN155]] / [[CHN5]] D87, D88: `POST /gmail/push` on local D1 with locally minted RS256 keys served through the injected `fetch`. Nothing reaches the network.
const KEY = new Uint8Array(32).fill(3)
const ENV = { GOOGLE_CLIENT_ID: 'fake-client-id.apps.test', GOOGLE_CLIENT_SECRET: 'fake-client-secret', OAUTH_STATE_SECRET: 'state-secret-for-tests', CREDENTIALS_KEY: Buffer.from(KEY).toString('base64'), PUBLIC_BASE_URL: PUSH.publicBaseUrl }
const PUSH_ENV = { GMAIL_TOPIC_NAME: PUSH.topicName, GMAIL_PUSH_SUBSCRIPTION: PUSH.subscription, GMAIL_PUSH_SERVICE_ACCOUNT: PUSH.serviceAccount }
const SEC = 1000

let e: Engine
let key: PushKey
let now: Date
let created: Array<{ id: string; params: MailSyncParams }>
let instances: MailSyncInstances
let jwks: ReturnType<typeof jwksFetch>
let connId: string
beforeAll(async () => {
  e = await openD1Engine()
  key = await newPushKey()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date('2026-11-05T10:00:00.000Z')
  created = []
  instances = { create: async (o) => void created.push(o) }
  jwks = jwksFetch([key])
  connId = await seedGmailConnection(e, { key: KEY, refreshToken: 'rt-1', mailbox: 'owner@vault.test', lastSyncedAt: '2026-11-05T09:59:00.000Z' })
  await e.insert('gmail_watches', { connection_id: connId, mailbox: 'owner@vault.test', expires_at: '2026-11-12T10:00:00.000Z' })
})

const app = (over: { env?: Record<string, string | undefined>; instances?: MailSyncInstances | null; binding?: Engine['binding'] } = {}) => {
  const env = over.env ?? { ...ENV, ...PUSH_ENV }
  const { config } = parseGmailConfig(env)
  const { config: push, problems } = parsePushConfig(env)
  return createApp({
    storage: () => over.binding ?? e.binding,
    userAuthenticator: fakeUserAuthenticator(),
    clock: () => now,
    newId: () => uuidv7(now),
    gmail: { config, push, pushProblems: problems, fetch: jwks.fetch, ...(over.instances === null ? {} : { instances: over.instances ?? instances }) },
  })
}
const post = async (a: ReturnType<typeof app>, o: { token?: string | null; header?: string; body?: string } = {}) => {
  const headers: Record<string, string> = {}
  if (o.header !== undefined) headers.authorization = o.header
  else if (o.token !== null) headers.authorization = `Bearer ${o.token ?? (await signPushToken(key, now))}`
  const res = await a.request(`${PUSH.publicBaseUrl}/gmail/push`, { method: 'POST', headers, body: o.body ?? pushBody() })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const state = async () => (await e.rows('mail_sync_state')).find((r) => r.connection_id === connId)!
const snapshot = async () => JSON.stringify({ state: await e.rows('mail_sync_state'), cursors: await e.rows('mail_sync_cursors'), watches: await e.rows('gmail_watches'), events: (await e.rows('events')).length })
const raw = (sql: string, ...binds: unknown[]) => e.d1!.prepare(sql).bind(...binds).run()

describe('the verifier (D87): every refusal is 401 with no write and no instance', () => {
  const hs256 = async (): Promise<string> => await new SignJWT({ email: PUSH.serviceAccount, email_verified: true }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://accounts.google.com').setAudience(PUSH.audience).setExpirationTime('1h').sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'))
  const cases: Array<[string, () => Promise<string>]> = [
    ['a wrong aud', () => signPushToken(key, now, { aud: 'https://vault.test/gmail/push/' })],
    ['an aud of another origin', () => signPushToken(key, now, { aud: 'https://other.test/gmail/push' })],
    ['a wrong email', () => signPushToken(key, now, { email: 'someone-else@vault-p.iam.gserviceaccount.com' })],
    ['an absent email', () => signPushToken(key, now, { email: null })],
    ['email_verified false', () => signPushToken(key, now, { email_verified: false })],
    ['email_verified absent', () => signPushToken(key, now, { email_verified: null })],
    ['an expired token beyond the 30 s tolerance', () => signPushToken(key, now, { expIn: -31 })],
    ['a token with no exp', () => signPushToken(key, now, { expIn: null })],
    ['a wrong iss', () => signPushToken(key, now, { iss: 'https://accounts.evil.test' })],
    ['an HS256 header', hs256],
    ['a key that is not in the JWKS', async () => signPushToken(await newPushKey('stranger'), now)],
    ['a known kid with another key', async () => signPushToken({ ...(await newPushKey('push-key-1')) }, now)],
  ]
  it.each(cases)('%s', async (_name, mint) => {
    const before = await snapshot()
    const res = await post(app(), { token: await mint() })
    expect([res.status, res.body.error.code]).toEqual([401, 'unauthenticated'])
    expect(await snapshot()).toBe(before)
    expect(created).toEqual([])
  })
  it('a body for another subscription is 401, after the token passed', async () => {
    const before = await snapshot()
    const res = await post(app(), { body: pushBody({ subscription: 'projects/vault-p/subscriptions/other' }) })
    expect(res.status).toBe(401)
    expect(await snapshot()).toBe(before)
    expect(created).toEqual([])
  })
  it('a token within the tolerance (expired 20 s ago), an array-free aud, and the bare accounts.google.com iss all pass', async () => {
    expect((await post(app(), { token: await signPushToken(key, now, { expIn: -20 }) })).status).toBe(204)
    expect((await post(app(), { token: await signPushToken(key, now, { iss: 'accounts.google.com' }) })).status).toBe(204)
  })
  it('the service account is compared case-insensitively', async () => {
    expect((await post(app(), { token: await signPushToken(key, now, { email: PUSH.serviceAccount.toUpperCase() }) })).status).toBe(204)
  })
})

describe('the JWKS is fetched only for a well-formed bearer (D87)', () => {
  it.each([
    ['no header', { token: null }],
    ['an empty bearer', { header: 'Bearer ' }],
    ['a bearer that is not a JWT', { header: 'Bearer not-a-jwt' }],
    ['two segments', { header: 'Bearer a.b' }],
    ['the Basic scheme', { header: 'Basic dXNlcjpwYXNz' }],
    ['an unsigned token', { header: `Bearer ${btoa('{"alg":"none"}')}.${btoa('{}')}.` }],
  ] as const)('%s: 401 and not one fetch', async (_name, o) => {
    const res = await post(app(), o as never)
    expect(res.status).toBe(401)
    expect(jwks.urls).toEqual([])
  })
  it('an HS256 or alg none header is refused before the fetch too (an unauthenticated caller cannot make the Worker call Google)', async () => {
    const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'))
    expect((await post(app(), { token: hs })).status).toBe(401)
    expect(jwks.urls).toEqual([])
  })
  it('a good token fetches the JWKS once per request, no cache', async () => {
    const a = app()
    await post(a)
    await post(a)
    expect(jwks.urls).toHaveLength(2)
  })
  it.each(['status', 'throw', 'bad_json'] as const)('a JWKS fetch that fails (%s) is 503 so Pub/Sub retries, with no write', async (mode) => {
    jwks.mode = mode
    const before = await snapshot()
    const res = await post(app())
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('jwks_unavailable')
    expect(await snapshot()).toBe(before)
    expect(created).toEqual([])
  })
})

describe('push to sync (D88)', () => {
  it('a verified push for the watched mailbox (mixed case) is 204, sets sync_requested_at and creates one instance; no event', async () => {
    const eventsBefore = (await e.rows('events')).length
    const res = await post(app(), { body: pushBody({ emailAddress: 'Owner@Vault.TEST' }) })
    expect(res.status).toBe(204)
    expect((await state()).sync_requested_at).toBe(now.toISOString())
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ connection_id: connId })
    expect(created[0]!.id).toMatch(new RegExp(`^mail-sync-${connId}-[0-9a-f-]{36}$`))
    expect((await e.rows('events')).length).toBe(eventsBefore)
  })
  it('the notification data may be standard or url base64', async () => {
    const data = btoa(JSON.stringify({ emailAddress: 'owner@vault.test', historyId: '1' }))
    expect((await post(app(), { body: pushBody({ data }) })).status).toBe(204)
    expect(created).toHaveLength(1)
  })
  const cases: Array<[string, () => Promise<void>, string?]> = [
    ['an unknown mailbox', async () => {}, 'nobody@vault.test'],
    ['a soft-deleted connection', async () => void (await raw('update channel_connections set deleted_at = ? where id = ?', '2026-11-05T09:00:00.000Z', connId))],
    ['a reauth_required connection', async () => void (await raw("update channel_connections set status = 'reauth_required' where id = ?", connId))],
    ['a suspended connection', async () => void (await raw("update channel_connections set status = 'suspended' where id = ?", connId))],
    ['a connection with no watch row (the empty state)', async () => void (await raw('delete from gmail_watches where connection_id = ?', connId))],
  ]
  it.each(cases)('%s: 204, no instance, no write', async (_n, arrange, mailbox) => {
    await arrange()
    const before = await snapshot()
    const res = await post(app(), { body: pushBody({ emailAddress: mailbox ?? 'owner@vault.test' }) })
    expect(res.status).toBe(204)
    expect(created).toEqual([])
    expect(await snapshot()).toBe(before)
  })
  it('verified data that does not decode is 204 and a log line without the address, never a 4xx', async () => {
    const warn: string[] = []
    const spy = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation((...a) => void warn.push(a.join(' ')))
    try {
      for (const data of ['!!!not base64!!!', btoa('not json'), btoa(JSON.stringify({ historyId: '1' })), btoa(JSON.stringify({ emailAddress: 42 }))]) {
        const before = await snapshot()
        expect((await post(app(), { body: pushBody({ data }) })).status).toBe(204)
        expect(await snapshot()).toBe(before)
      }
    } finally {
      spy.mockRestore()
    }
    expect(created).toEqual([])
    expect(warn.length).toBeGreaterThan(0)
    expect(warn.join('\n')).not.toContain('owner@vault.test')
  })
  it('an oversized body (over 64 KiB) after a good token is 204 and nothing is written', async () => {
    const before = await snapshot()
    const res = await post(app(), { body: pushBody({ data: 'A'.repeat(70_000) }) })
    expect(res.status).toBe(204)
    expect(await snapshot()).toBe(before)
    expect(created).toEqual([])
  })
  it('historyId is never used: a push below or above the cursor leaves mail_sync_cursors unchanged and still requests', async () => {
    const cursorBefore = JSON.stringify(await e.rows('mail_sync_cursors'))
    for (const historyId of ['1', '99999999']) {
      now = new Date(now.getTime() + 120 * SEC)
      const res = await post(app(), { body: pushBody({ historyId }) })
      expect(res.status).toBe(204)
      expect((await state()).sync_requested_at).toBe(now.toISOString())
    }
    expect(JSON.stringify(await e.rows('mail_sync_cursors'))).toBe(cursorBefore)
    expect(created).toHaveLength(2)
  })
})

describe('no amplification (D88)', () => {
  it('20 sequential pushes with no run create one instance, and each advances sync_requested_at', async () => {
    const a = app()
    for (let i = 0; i < 20; i++) {
      now = new Date(now.getTime() + 1 * SEC)
      expect((await post(a)).status).toBe(204)
      expect((await state()).sync_requested_at).toBe(now.toISOString())
    }
    expect(created).toHaveLength(1)
  })
  it('after the 60 s window with the request still unserved, the next push creates an instance again', async () => {
    const a = app()
    await post(a)
    now = new Date(now.getTime() + 61 * SEC)
    await post(a)
    expect(created).toHaveLength(2)
  })
  it('a served request (last_success_at after it) does not suppress: the next push creates an instance', async () => {
    const a = app()
    await post(a)
    now = new Date(now.getTime() + 5 * SEC)
    await raw('update mail_sync_state set last_success_at = ? where connection_id = ?', now.toISOString(), connId)
    now = new Date(now.getTime() + 5 * SEC)
    await post(a)
    expect(created).toHaveLength(2)
  })
  it('with a lease held no instance is created, but sync_requested_at is advanced past the run start so its finish re-passes', async () => {
    const passStart = new Date(now.getTime() - 5 * SEC).toISOString()
    await raw('update mail_sync_state set lease_until = ?, run_id = ? where connection_id = ?', new Date(now.getTime() + 60 * SEC).toISOString(), 'run-1', connId)
    expect((await post(app())).status).toBe(204)
    expect(created).toEqual([])
    expect((await state()).sync_requested_at).toBe(now.toISOString())
    expect(((await state()).sync_requested_at as string) > passStart).toBe(true)
    const done = await finishPass({ binding: e.binding, organizationId: e.organizationId, clock: () => new Date(now.getTime() + 10 * SEC) }, connId, 'run-1', passStart, true)
    expect(done.again).toBe(true)
  })
  it('a suppressed request whose instance never came is selected by the cron (dueConnections) once the lease is gone, from this exact row', async () => {
    // Synced a minute ago and not stale: only the recorded request can make it due.
    await raw('update mail_sync_state set last_success_at = ?, sync_requested_at = null where connection_id = ?', new Date(now.getTime() - 60 * SEC).toISOString(), connId)
    expect(await dueConnections({ binding: e.binding, organizationId: e.organizationId }, now)).toEqual([])
    await raw('update mail_sync_state set lease_until = ?, run_id = ? where connection_id = ?', new Date(now.getTime() + 30 * SEC).toISOString(), 'run-1', connId)
    await post(app())
    expect(created).toEqual([])
    await raw('update mail_sync_state set lease_until = null, run_id = null where connection_id = ?', connId)
    expect(await dueConnections({ binding: e.binding, organizationId: e.organizationId }, now)).toEqual([connId])
  })
})

describe('failures after the mark (D88)', () => {
  it('an instance that cannot be created is 204 with the request kept, and the cron selects it', async () => {
    await raw('update mail_sync_state set last_success_at = ? where connection_id = ?', new Date(now.getTime() - 60 * SEC).toISOString(), connId)
    const res = await post(app({ instances: { create: async () => Promise.reject(new Error('workflows down')) } }))
    expect(res.status).toBe(204)
    expect((await state()).sync_requested_at).toBe(now.toISOString())
    expect(await dueConnections({ binding: e.binding, organizationId: e.organizationId }, now)).toEqual([connId])
  })
  it('a D1 failure is 500, so Pub/Sub retries', async () => {
    const broken = { ...e.binding, runtime: { ...e.binding.runtime, execute: () => Promise.reject(new Error('d1 down')) } } as Engine['binding']
    const res = await post(app({ binding: broken }))
    expect(res.status).toBe(500)
    expect(created).toEqual([])
  })
})

describe('push off (D87): the route answers 404', () => {
  const without = (name: keyof typeof PUSH_ENV): Record<string, string | undefined> => ({ ...ENV, ...PUSH_ENV, [name]: undefined })
  it.each([['GMAIL_TOPIC_NAME'], ['GMAIL_PUSH_SUBSCRIPTION'], ['GMAIL_PUSH_SERVICE_ACCOUNT']] as const)('without %s', async (name) => {
    const before = await snapshot()
    const res = await post(app({ env: without(name) }))
    expect(res.status).toBe(404)
    expect(jwks.urls).toEqual([])
    expect(created).toEqual([])
    expect(await snapshot()).toBe(before)
  })
  it('without PUBLIC_BASE_URL', async () => {
    expect((await post(app({ env: { ...ENV, ...PUSH_ENV, PUBLIC_BASE_URL: undefined } }))).status).toBe(404)
  })
  it('without the MAIL_SYNC binding, and with Gmail unconfigured', async () => {
    expect((await post(app({ instances: null }))).status).toBe(404)
    expect((await post(app({ env: { ...PUSH_ENV, PUBLIC_BASE_URL: PUSH.publicBaseUrl } }))).status).toBe(404)
    expect(jwks.urls).toEqual([])
  })
  it('the startup log names the missing variables and never a value', () => {
    const warn: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => void warn.push(a.join(' '))
    try {
      app({ env: without('GMAIL_PUSH_SUBSCRIPTION') })
    } finally {
      console.warn = orig
    }
    const line = warn.find((l) => l.includes('push is off'))!
    expect(line).toContain('GMAIL_PUSH_SUBSCRIPTION')
    for (const v of [PUSH.topicName, PUSH.serviceAccount, PUSH.publicBaseUrl]) expect(line).not.toContain(v)
  })
})
