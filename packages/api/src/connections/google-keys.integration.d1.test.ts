import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { GOOGLE_JWKS_URL } from '../channels/gmail/push.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { FAKE_ENDPOINTS, FAKE_GMAIL_BASE, FakeGoogle, type FakeAccount } from '../test/google.js'
import { PUSH, newPushKey, pushBody, signPushToken, type PushKey } from '../test/push.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { parseGmailConfig, parsePushConfig } from './config.js'

// [[CORE577]] D21, P6 at the composition seam: ONE Google key cache serves `/inbound/gmail` and the connect callback's ID-token check. Google's keys are the real URL's, served by an injected `fetch` that counts them;
// the ID token is signed by FakeGoogle (kid `fake-google-1`), the push token by a local key, and which of the two the JWKS holds is the test's to choose.
const ENV = {
  GOOGLE_CLIENT_ID: 'fake-client-id.apps.test',
  GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  OAUTH_STATE_SECRET: 'state-secret-for-tests',
  CREDENTIALS_KEY: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
  PUBLIC_BASE_URL: PUSH.publicBaseUrl,
  GMAIL_TOPIC_NAME: PUSH.topicName,
  GMAIL_PUSH_SUBSCRIPTION: PUSH.subscription,
  GMAIL_PUSH_SERVICE_ACCOUNT: PUSH.serviceAccount,
}
const ANN: FakeAccount = { sub: 'sub-ann', email: 'ann@example.test', historyId: '555' }
let e: Engine
let google: FakeGoogle
let pushKey: PushKey
let now: Date
let certs: string[]
let googleKeyServed: boolean
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: ENV.GOOGLE_CLIENT_ID, clientSecret: ENV.GOOGLE_CLIENT_SECRET })
  google.clock = () => now.getTime()
  pushKey = await newPushKey()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date('2026-11-05T10:00:00.000Z')
  certs = []
  googleKeyServed = true
})
afterEach(() => vi.restoreAllMocks())

/** Google's one JWKS URL: the push key always, FakeGoogle's key while `googleKeyServed`. Every other URL is FakeGoogle's. */
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url !== GOOGLE_JWKS_URL) return google.fetch(input, init)
  certs.push(url)
  const theirs = googleKeyServed
    ? (((await (await google.fetch(FAKE_ENDPOINTS.jwksUrl)).json()) as { keys: unknown[] }).keys ?? [])
    : []
  return new Response(JSON.stringify({ keys: [pushKey.jwk, ...theirs] }), { status: 200 })
}) as typeof fetch
const app = () => {
  const { config } = parseGmailConfig(ENV)
  const { config: push } = parsePushConfig(ENV)
  return createApp({
    storage: () => e.binding,
    userAuthenticator: fakeUserAuthenticator(),
    clock: () => now,
    newId: () => uuidv7(now),
    gmail: {
      config,
      push,
      instances: { create: async () => {} },
      endpoints: { ...FAKE_ENDPOINTS, jwksUrl: GOOGLE_JWKS_URL },
      fetch: fetchFn,
      gmailBaseUrl: FAKE_GMAIL_BASE,
      session: { mode: 'state-only' },
      roleOf: async () => 'owner',
    },
  })
}
const pushIt = async (a: ReturnType<typeof app>) =>
  a.request(`${PUSH.publicBaseUrl}/inbound/gmail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await signPushToken(pushKey, now)}` },
    // A verified notification that does not decode is acknowledged: nothing else runs.
    body: pushBody({ data: 'bm90LWpzb24' }),
  })
async function connect(a: ReturnType<typeof app>) {
  const res = await a.request(`${PUSH.publicBaseUrl}/meta/v1/connections/authorize`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: ['connections:read', 'connections:write'] })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ provider: 'google' }),
  })
  const { authorize_url } = (await res.json()) as { authorize_url: string }
  return a.request(await google.consent(authorize_url, ANN))
}

describe('one key cache per app, shared by push and the callback (D21, P6)', () => {
  it('a push, then a connect callback, cause one fetch of the keys', async () => {
    const a = app()
    expect((await pushIt(a)).status).toBe(204)
    expect(certs).toHaveLength(1)
    const done = await connect(a)
    expect(done.status, await done.clone().text()).toBe(200)
    expect(certs).toHaveLength(1)
  })
  it('the other way round: a callback, then a push, cause one fetch', async () => {
    const a = app()
    expect((await connect(a)).status).toBe(200)
    expect(certs).toHaveLength(1)
    expect((await pushIt(a)).status).toBe(204)
    expect(certs).toHaveLength(1)
  })
  it('a callback whose ID token carries a kid the cache lacks refetches once and succeeds', async () => {
    googleKeyServed = false
    const a = app()
    expect((await pushIt(a)).status).toBe(204)
    expect(certs).toHaveLength(1)
    // Google rotated: its key is served from now on. A minute later the callback's unknown kid is allowed one refetch.
    googleKeyServed = true
    now = new Date(now.getTime() + 61_000)
    const done = await connect(a)
    expect(done.status, await done.clone().text()).toBe(200)
    expect(certs).toHaveLength(2)
  })
  it("an unknown kid inside the minute of the last attempt causes no fetch and is the callback's existing refusal", async () => {
    googleKeyServed = false
    const a = app()
    expect((await pushIt(a)).status).toBe(204)
    googleKeyServed = true
    now = new Date(now.getTime() + 30_000)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = await connect(a)
    expect(refused.status).not.toBe(200)
    expect(await refused.text()).toContain('exchange_failed')
    expect(certs).toHaveLength(1)
  })
})
