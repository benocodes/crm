import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry } from '@vibase/api'
import { browserSignIn, createClient } from '@vibase/sdk'
import { uuidv7 } from '@vibase/storage'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[DX624]] cycle 1, group 6 (P2): `browserSignIn`, through `@vibase/sdk`'s public entry, against the REAL Better Auth composition in workerd: real discovery documents,
// the authorize navigation (simulated with the owner's session cookie, the only request that carries one), the real token endpoint (the real composition's `/auth`,
// `x-test-real-auth`, so its CORS answer is the one under test), and a call to /api with the access token. The SDK's own fetch adds an allowed `Origin` and never a cookie.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const APP = 'https://app.test'
const REDIRECT = `${APP}/cb`
let n = 0
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 250) + 1}` })

let bundle: Bundle
let w: Workerd
let cookie: string
let session: string
let clientId: string
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({
    bundle,
    bindings: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1', CORS_ALLOWED_ORIGINS: APP },
    paired: true,
  })
  await seedFirstPartyClient(w.control as never, { baseURL: BASE })
  const kit = authKitOver(((p: string, i: object) => w.call(p, { ...i, headers: ip() })) as never, BASE, declared)
  const { userId, cookie: c } = await kit.signUp('owner@x.test')
  cookie = c
  const owner = uuidv7()
  await seedPrincipal(w.d1, {
    id: owner,
    kind: 'user',
    email: 'owner@x.test',
    authProvider: 'better-auth',
    authSubject: userId,
  })
  await seedMembership(w.d1, {
    organizationId: (await import('@vibase/auth/test')).PAIRED_ORG,
    userId: owner,
    role: 'owner',
  })
  session = await kit.sessionJwt(cookie)
  const made = await w.mf.dispatchFetch(`${BASE}/meta/v1/oauth-clients`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', ...ip() },
    body: JSON.stringify({ name: 'Deals board', redirect_uris: [REDIRECT] }),
  })
  const rec = (await made.json()) as Record<string, any>
  expect(made.status, JSON.stringify(rec)).toBe(201)
  clientId = rec.client_id
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

interface Sent {
  url: string
  init: RequestInit
  status: number
  headers: Headers
}

/** The SDK's (and createClient's) fetch: into the Worker, as the app's origin, with no cookie. `mutate` rewrites a request body, for the absence mutation. */
function appFetch(sent: Sent[], mutate?: (url: string, body: string) => string) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const path = url.replace(BASE, '')
    const body = typeof init.body === 'string' && mutate ? mutate(url, init.body) : init.body
    const headers = {
      ...(init.headers as Record<string, string> | undefined),
      origin: APP,
      ...ip(),
      ...(path.startsWith('/auth/') ? { 'x-test-real-auth': '1' } : {}),
    }
    const res = (await w.mf.dispatchFetch(url, {
      method: init.method,
      headers,
      body: (body ?? undefined) as never,
    })) as unknown as Response
    sent.push({ url, init: { ...init, headers, body: body as never }, status: res.status, headers: res.headers })
    return res
  }) as typeof fetch
}

/** The authorize navigation: top-level, with the owner's session cookie (the API origin's host-only cookie), answered by a redirect to the registered URI. */
async function navigateTo(authorizeUrl: string): Promise<string> {
  const res = (await w.mf.dispatchFetch(authorizeUrl, {
    redirect: 'manual',
    headers: { origin: BASE, ...ip(), cookie },
  })) as unknown as Response
  const body = await res.text()
  // Better Auth answers a fetch-style authorize with a `302` or with `{ redirect: true, url }` (the CORE627 helper reads both).
  let location = res.status === 302 ? res.headers.get('location') : null
  if (!location) {
    try {
      location = (JSON.parse(body) as { url?: string }).url ?? null
    } catch {
      /* an error body */
    }
  }
  expect(location, `authorize answered ${res.status} ${body}`).toBeTruthy()
  return new URL(location!, BASE).toString()
}

/** A new first-party client for the owner (a test that deletes its client needs its own). */
async function newClient(): Promise<string> {
  const made = await w.mf.dispatchFetch(`${BASE}/meta/v1/oauth-clients`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', ...ip() },
    body: JSON.stringify({ name: 'Refresh board', redirect_uris: [REDIRECT] }),
  })
  const rec = (await made.json()) as Record<string, any>
  expect(made.status, JSON.stringify(rec)).toBe(201)
  return rec.client_id
}

async function run(mutate?: (url: string, body: string) => string, id: string = clientId) {
  const sent: Sent[] = []
  const loc = { href: `${APP}/boards?x=1`, origin: APP }
  const store = new Map<string, string>()
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const navigated: string[] = []
  const signIn = browserSignIn({
    url: BASE,
    clientId: id,
    redirectUri: REDIRECT,
    fetch: appFetch(sent, mutate),
    location: loc,
    navigate: (u) => navigated.push(u),
    replaceUrl: () => {},
    sessionStorage,
  })
  void signIn.signIn().catch(() => {})
  for (let i = 0; i < 500 && navigated.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
  expect(navigated).toHaveLength(1)
  loc.href = await navigateTo(navigated[0])
  const done = await signIn.handleRedirect().then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  return { signIn, sent, done, loc, store, tokenKey: `vibase.sign-in:${BASE}:${id}:token` }
}

describe('DX624 group 6: browserSignIn against the real Worker (P2)', () => {
  it('signIn, authorize, handleRedirect and a call to /api succeed; the token request had no cookie and its answer is credential-free for the app origin', async () => {
    const { signIn, sent, done, loc } = await run()
    expect(loc.href.startsWith(`${REDIRECT}?`)).toBe(true)
    const callback = new URL(loc.href)
    expect(callback.searchParams.get('code')).toBeTruthy()
    expect(callback.searchParams.get('state')).toBeTruthy()
    expect(callback.searchParams.get('iss')).toBe(`${BASE}/auth`)
    expect('error' in done ? String(done.error) : '').toBe('')
    expect(done).toEqual({ value: { returnTo: '/boards?x=1' } })

    const tokenReq = sent.find((s) => s.url.endsWith('/auth/oauth2/token'))!
    expect(tokenReq).toBeTruthy()
    expect(new Headers(tokenReq.init.headers as Record<string, string>).has('cookie')).toBe(false)
    expect(tokenReq.init.credentials).toBe('omit')
    expect(tokenReq.headers.get('access-control-allow-origin')).toBe(APP)
    expect(tokenReq.headers.get('access-control-allow-credentials')).toBeNull()
    // discovery was read from the Worker's real documents
    expect(sent.some((s) => s.url === `${BASE}/.well-known/vibase`)).toBe(true)
    expect(sent.some((s) => s.url === `${BASE}/.well-known/oauth-authorization-server/auth`)).toBe(true)

    expect(signIn.isSignedIn()).toBe(true)
    const apiSent: Sent[] = []
    const vibase = createClient({ url: BASE, auth: signIn.token, fetch: appFetch(apiSent) })
    const page = await vibase.contacts.list()
    expect(Array.isArray(page.data)).toBe(true)
    expect(apiSent[0].status).toBe(200)
    expect(new Headers(apiSent[0].init.headers as Record<string, string>).get('authorization')).toMatch(/^Bearer /)
  }, 60_000)

  // The round trip's absence mutation is M15 (RESULT.md): drop `resource` from both authorize and token and the first test goes red (/api answers 401).
  // (Dropping it from the token request alone does not: authorize's `resource` binds the audience, finding 624.26.) The forged cases below are extra live-path
  // checks: a callback with a forged `iss` or `state` is refused before any token request, against the real documents.
  it.each([
    ['iss', 'issuer_mismatch'],
    ['state', 'state_mismatch'],
  ])(
    'a callback with a forged %s is %s and sends no token request (live path)',
    async (param, code) => {
      const sent: Sent[] = []
      const loc = { href: `${APP}/boards`, origin: APP }
      const store = new Map<string, string>()
      const navigated: string[] = []
      const signIn = browserSignIn({
        url: BASE,
        clientId,
        redirectUri: REDIRECT,
        fetch: appFetch(sent),
        location: loc,
        navigate: (u) => navigated.push(u),
        replaceUrl: () => {},
        sessionStorage: {
          getItem: (k) => store.get(k) ?? null,
          setItem: (k, v) => void store.set(k, v),
          removeItem: (k) => void store.delete(k),
        },
      })
      void signIn.signIn().catch(() => {})
      for (let i = 0; i < 500 && navigated.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
      const back = new URL(await navigateTo(navigated[0]))
      back.searchParams.set(param, param === 'iss' ? 'https://evil.test/auth' : 'forged')
      loc.href = back.toString()
      const error = await signIn.handleRedirect().then(
        () => null,
        (e) => e,
      )
      expect(error?.code).toBe(code)
      expect(sent.some((s) => s.url.endsWith('/auth/oauth2/token'))).toBe(false)
      expect(signIn.isSignedIn()).toBe(false)
    },
    60_000,
  )
})

// ---------------------------------------------------------------- DX636 group 5
/** Moves the stored access token inside the 60 s margin, as the passing of time would. */
const forceMargin = (store: Map<string, string>, key: string) => {
  const record = JSON.parse(store.get(key) as string)
  store.set(key, JSON.stringify({ ...record, expires_at: Date.now() + 30_000 }))
  return record as { access_token: string; refresh_token?: string }
}
const refreshRequests = (sent: Sent[]) =>
  sent.filter((s) => s.url.endsWith('/auth/oauth2/token') && String(s.init.body).includes('grant_type=refresh_token'))

describe('DX636 group 5: token() refresh against the real Worker (D5)', () => {
  it('refreshes inside the margin: the new access token differs from the first and /api accepts it', async () => {
    const { signIn, sent, store, tokenKey } = await run()
    const first = forceMargin(store, tokenKey)
    const refreshed = await signIn.token()
    expect(refreshed).toBeTruthy()
    expect(refreshed).not.toBe(first.access_token)
    const requests = refreshRequests(sent)
    expect(requests).toHaveLength(1)
    expect(requests[0].status).toBe(200)
    expect(new Headers(requests[0].init.headers as Record<string, string>).has('cookie')).toBe(false)
    expect(requests[0].headers.get('access-control-allow-origin')).toBe(APP)
    const stored = JSON.parse(store.get(tokenKey) as string)
    expect(stored.access_token).toBe(refreshed)
    // Finding (RESULT.md): whether Better Auth rotated the refresh token.
    console.info(`DX636 finding: refresh token rotated = ${stored.refresh_token !== first.refresh_token}`)
    expect(stored.refresh_token).not.toBe(first.refresh_token) // Better Auth 1.7.22 rotates on refresh
    const apiSent: Sent[] = []
    const vibase = createClient({ url: BASE, auth: signIn.token, fetch: appFetch(apiSent) })
    expect(Array.isArray((await vibase.contacts.list()).data)).toBe(true)
    expect(apiSent[0].status).toBe(200)
    expect(new Headers(apiSent[0].init.headers as Record<string, string>).get('authorization')).toBe(
      `Bearer ${refreshed}`,
    )
    expect(refreshRequests(sent)).toHaveLength(1) // the client's call used the stored token: no second refresh
  }, 60_000)

  it('P1 finding: `resource` is not load-bearing on refresh (dropped from the refresh request only, the token endpoint answers 200 and /api accepts the token)', async () => {
    const dropResource = (_url: string, body: string) => {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'refresh_token') form.delete('resource')
      return form.toString()
    }
    const { signIn, sent, store, tokenKey } = await run(dropResource)
    forceMargin(store, tokenKey)
    const refreshed = await signIn.token().catch((e) => `rejected:${e.code}`)
    const request = refreshRequests(sent)[0]
    expect(new URLSearchParams(String(request.init.body)).has('resource')).toBe(false)
    const apiSent: Sent[] = []
    const vibase = createClient({ url: BASE, auth: () => refreshed, fetch: appFetch(apiSent) })
    const outcome = await vibase.contacts.list().then(
      () => 200,
      (e) => e.status,
    )
    console.info(`DX636 finding: refresh without resource: token endpoint ${request.status}, /api ${outcome}`)
    expect(refreshed).not.toMatch(/^rejected/)
    expect(request.status).toBe(200)
    expect(outcome).toBe(200)
  }, 60_000)

  it('a deleted client: the next refresh resolves null and the record is gone', async () => {
    const id = await newClient()
    const { signIn, sent, store, tokenKey } = await run(undefined, id)
    forceMargin(store, tokenKey)
    const del = (await w.mf.dispatchFetch(`${BASE}/meta/v1/oauth-clients/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session}`, ...ip() },
    })) as unknown as Response
    expect(del.status).toBe(204)
    expect(await signIn.token()).toBeNull()
    const request = refreshRequests(sent)[0]
    console.info(`DX636 finding: deleted client refresh answered ${request.status}`)
    expect([400, 401]).toContain(request.status)
    expect(store.get(tokenKey)).toBeUndefined()
    expect(signIn.isSignedIn()).toBe(false)
  }, 60_000)
})
