import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { CLERK_WEBHOOK_PATH } from '../directory/webhook.js'
import { CALLBACK_PATH } from '../connections/operations.js'
import { PUSH_PATH } from '../channels/gmail/push.js'
import { parseGmailConfig, parsePushConfig } from '../connections/config.js'
import { createApp } from './app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { PUSH, jwksFetch, newPushKey, signPushToken, type PushKey } from '../test/push.js'
import { clerkWebhook, signClerkWebhook, testClerkAdapter } from '../test/clerk.js'

// [[API503]] D1, D4: the three machine endpoints answer only at their new paths; the old ones reach no route.
const BASE = PUSH.publicBaseUrl
const KEY = new Uint8Array(32).fill(3)
const ENV = {
  GOOGLE_CLIENT_ID: 'fake-client-id.apps.test',
  GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  OAUTH_STATE_SECRET: 'state-secret-for-tests',
  CREDENTIALS_KEY: Buffer.from(KEY).toString('base64'),
  PUBLIC_BASE_URL: BASE,
  GMAIL_TOPIC_NAME: PUSH.topicName,
  GMAIL_PUSH_SUBSCRIPTION: PUSH.subscription,
  GMAIL_PUSH_SERVICE_ACCOUNT: PUSH.serviceAccount,
}
const NOT_FOUND = { error: { code: 'not_found', message: 'no such route' } }

let e: Engine
let key: PushKey
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
  key = await newPushKey()
  const { config } = parseGmailConfig(ENV)
  const { config: push } = parsePushConfig(ENV)
  const clerk = await testClerkAdapter()
  app = createApp({
    storage: () => e.binding,
    authAdapter: clerk.adapter,
    newId: () => uuidv7(),
    gmail: { config, push, fetch: jwksFetch([key]).fetch, instances: { create: async () => undefined } },
  })
})
afterAll(async () => {
  await e.close()
})

const signedClerk = () => signClerkWebhook(clerkWebhook('session.created', { id: 'sess_1' }))
const clerkAt = (path: string) => {
  const s = signedClerk()
  return app.request(`${BASE}${path}`, { method: 'POST', headers: s.headers, body: s.body })
}
const pushAt = async (path: string, aud: string) =>
  app.request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await signPushToken(key, new Date(), { aud })}` },
    body: '{}',
  })

describe('the constants', () => {
  it('are the family shapes', () => {
    expect(CALLBACK_PATH).toBe('/oauth/callback/google')
    expect(PUSH_PATH).toBe('/inbound/gmail')
    expect(CLERK_WEBHOOK_PATH).toBe('/inbound/clerk')
  })
})

describe('the new paths reach their handlers', () => {
  it("GET /oauth/callback/google reaches the callback (a bad state is the callback's own answer, not not_found)", async () => {
    const res = await app.request(`${BASE}/oauth/callback/google?code=x&state=y`)
    expect(res.status).not.toBe(404)
  })
  it('POST /inbound/gmail verifies the token (aud = base + /inbound/gmail passes the audience check)', async () => {
    const res = await pushAt('/inbound/gmail', `${BASE}/inbound/gmail`)
    expect(res.status).not.toBe(404)
  })
  it('POST /inbound/clerk verifies the Svix signature and answers as the handler does', async () => {
    const res = await clerkAt('/inbound/clerk')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    const s = signedClerk()
    const bad = await app.request(`${BASE}/inbound/clerk`, {
      method: 'POST',
      headers: { ...s.headers, 'svix-signature': 'v1,AAAA' },
      body: s.body,
    })
    expect(bad.status).toBe(401)
  })
})

describe('the old paths are gone (no alias, no redirect)', () => {
  it.each([
    ['GET', '/oauth/google/callback?code=x&state=y'],
    ['POST', '/gmail/push'],
    ['POST', '/webhooks/clerk'],
  ])('%s %s is 404 not_found', async (method, path) => {
    const s = signedClerk()
    const res = await app.request(`${BASE}${path}`, {
      method,
      headers: s.headers,
      ...(method === 'POST' ? { body: s.body } : {}),
      redirect: 'manual',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
  })
})

describe('the push audience moved (D3)', () => {
  it('is the base plus PUSH_PATH', () => {
    expect(parsePushConfig(ENV).config!.audience).toBe(`${BASE}${PUSH_PATH}`)
    expect(parsePushConfig(ENV).config!.audience).toBe(`${BASE}/inbound/gmail`)
  })
  it('a token minted for the old audience is refused 401', async () => {
    const res = await pushAt('/inbound/gmail', `${BASE}/gmail/push`)
    expect(res.status).toBe(401)
  })
})
