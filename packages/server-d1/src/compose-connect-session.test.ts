import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import {
  NOW,
  bootstrapD1,
  clerkKit,
  composeD1Worker as composeKit,
  openWorkerD1,
  openWorkerPair,
  type ClerkKit,
  type WorkerD1,
  type WorkerPair,
} from './test/kit.js'

// [[CORE572]] D8, D9, P2, P5 through the real Worker composition: on `better-auth` the Gmail connect callback checks the browser's Better Auth session against the state's user;
// on `clerk` and `none` it stays state-only. The sessions come from the REAL Better Auth handler; the state is signed here with the callback's own algorithm (HMAC-SHA256 over the JSON claims).
const GMAIL_ENV = {
  GOOGLE_CLIENT_ID: 'fake-client-id.apps.test',
  GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  OAUTH_STATE_SECRET: 'state-secret',
  CREDENTIALS_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
}
const MISMATCH = 'Sign in to this workspace in this browser as the person who started the connection, then start again.'
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
async function stateFor(userId: string): Promise<string> {
  const enc = new TextEncoder()
  const payload = b64url(
    enc.encode(JSON.stringify({ user_id: userId, nonce: 'n-1', expires_at: Date.now() + 10 * 60_000 })),
  )
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(GMAIL_ENV.OAUTH_STATE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))))}`
}
const callbackUrl = async (userId: string, extra = 'error=access_denied') =>
  `${AUTH_BASE}/oauth/callback/google?${extra}&state=${await stateFor(userId)}`

describe('better-auth: the callback checks the session (D8, P2, P5)', () => {
  let w: WorkerPair
  let n = 0
  let wk: ReturnType<typeof composeD1Worker>
  let userId: string
  let cookie: string
  let setCookie: string
  beforeAll(async () => {
    w = await openWorkerPair()
  }, 30_000)
  afterAll(() => w.dispose())
  beforeEach(async () => {
    await w.reset()
    await w.d1.prepare('drop table if exists d1_migrations').run()
    await createMigrationTracker(w.d1)
    await recordMigrations(
      w.d1,
      MIGRATIONS.map((m) => m.name),
    )
    const r = await bootstrapD1(
      w.d1,
      {
        organizationName: 'Acme',
        authProvider: 'better-auth',
        authOrgId: 'better-auth',
        publicBaseUrl: AUTH_BASE,
        ownerEmail: 'owner@x.test',
      },
      { control: openControlDb(w.control) },
    )
    const invite = new URL(r.ownerInvitation!.url).hash.replace(/^#token=/, '')
    wk = composeD1Worker({
      DB: w.d1,
      CONTROL_DB: w.control,
      AUTH_PROVIDER: 'better-auth',
      AUTH_SECRET,
      PUBLIC_BASE_URL: AUTH_BASE,
      ...GMAIL_ENV,
    })
    const up = await wk.fetch(
      new Request(`${AUTH_BASE}/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: AUTH_BASE, 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${++n}` },
        body: JSON.stringify({
          name: 'Owner',
          email: 'owner@x.test',
          password: 'a long enough password 123',
          invitation_token: invite,
        }),
      }),
    )
    expect(up.status, await up.clone().text()).toBe(200)
    setCookie = up.headers.get('set-cookie')!
    cookie = setCookie.split(';')[0]!
    userId = ((await w.d1.prepare('select id from users').first()) as { id: string }).id
  })
  const hit = async (url: string, withCookie: string | null) =>
    wk.fetch(new Request(url, withCookie ? { headers: { cookie: withCookie } } : {}))

  it('refuses a cookie-less callback with session_mismatch/403 and the fixed text', async () => {
    const res = await hit(await callbackUrl(userId), null)
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toContain('<code>session_mismatch</code>')
    expect(text).toContain(MISMATCH)
  })

  it("passes the session step with the owner's real session (it ends at Google's denial) and refuses a cookie for no user", async () => {
    const res = await hit(await callbackUrl(userId), cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('<code>consent_denied</code>')
    const forged = await hit(await callbackUrl(userId), 'better-auth.session_token=forged.forged')
    expect(forged.status).toBe(403)
  })

  it("a signed state for another user with the owner's session is refused", async () => {
    const res = await hit(await callbackUrl(uuidv7(NOW)), cookie)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('<code>session_mismatch</code>')
  })

  it('P5: the real sign-in sets the session cookie SameSite=Lax on a path that covers /oauth/callback/google', () => {
    const attrs = setCookie.split(/,\s*(?=[^;,]+=)/).find((c) => /session_token/.test(c))!
    expect(attrs).toMatch(/SameSite=Lax/i)
    expect(attrs).not.toMatch(/SameSite=Strict/i)
    const path = /Path=([^;]+)/i.exec(attrs)?.[1]
    expect('/oauth/callback/google'.startsWith(path!)).toBe(true)
  })
})

describe('clerk and none: state-only (D9, P2)', () => {
  let w: WorkerD1
  let kit: ClerkKit
  beforeAll(async () => {
    w = await openWorkerD1()
    kit = await clerkKit()
  }, 30_000)
  afterAll(() => w?.dispose())
  beforeEach(async () => {
    await w.reset()
    await bootstrapD1(
      w.d1,
      { organizationName: 'Acme', agentName: 'bot', authOrgId: 'org_acme' },
      { now: NOW, newId: () => uuidv7(NOW) },
    )
  })
  const run = async (env: Partial<D1WorkerEnv>) =>
    composeKit({ DB: w.d1, PUBLIC_BASE_URL: AUTH_BASE, ...GMAIL_ENV, ...env }).fetch(
      new Request(await callbackUrl(uuidv7(NOW))),
    )
  it.each([
    ['clerk', () => kit.env],
    ['none', () => ({ AUTH_PROVIDER: '' })],
  ])('%s: a cookie-less callback with a valid state is past the session step (consent_denied)', async (_n, env) => {
    const res = await run(env() as Partial<D1WorkerEnv>)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('<code>consent_denied</code>')
  })
})
