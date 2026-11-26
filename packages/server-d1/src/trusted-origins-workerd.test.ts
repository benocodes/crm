import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_CORS_ALLOW_HEADERS } from './compose.js'
import { authKitOver } from './test/auth-kit.js'

// [[UI255]] D3, D7, D8 in workerd (groups 2, 3, 4): the REAL Worker module through test/entry-mint.ts. `/auth` without the `x-test-real-auth` header is the test composition (open admission: it signs people up, and trusts the
// same AUTH_TRUSTED_ORIGINS, so a test entry that forgot them fails group 2); with the header it is compose.ts's own `/auth` branch, where D7's CORS lives. `pending` is the same Worker on a database with no migrations.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const APP = 'https://app.example.com'
const BOTH = 'https://both.example.com' // a trusted app origin that is also in CORS_ALLOWED_ORIGINS (it calls /api too)
const WILD = 'https://*.wild.example.com'
const DEEP = 'https://a.b.wild.example.com' // depth 2, trusted only through the wildcard
const BARE = 'https://wild.example.com' // the zone's bare host: not matched
const BINDINGS = {
  AUTH_PROVIDER: 'better-auth',
  PUBLIC_BASE_URL: BASE,
  OPEN_ADMISSION: '1',
  AUTH_TRUSTED_ORIGINS: `${APP},${BOTH},${WILD}`,
  CORS_ALLOWED_ORIGINS: BOTH,
  AUTH_GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com',
  AUTH_GOOGLE_CLIENT_SECRET: 'gsecret-0123456789',
}

let bundle: Bundle
let w: Workerd
let pending: Workerd
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({ bundle, bindings: BINDINGS, paired: true })
  pending = await startWorkerd({ bundle, bindings: BINDINGS, migrate: false })
}, 120_000)
afterAll(async () => {
  await w?.dispose()
  await pending?.dispose()
  bundle?.dispose()
})

const kit = () => authKitOver(w.call as never, BASE, [])
const real = (inst: Workerd, path: string, init: Parameters<Workerd['call']>[1] = {}) =>
  inst.call(path, { ...init, headers: { 'x-test-real-auth': '1', ...init.headers } })
let n = 0
const account = async () => {
  const email = `p${n++}@auth.test`
  const { cookie } = await kit().signUp(email)
  return { email, cookie }
}
const cors = (res: Response) => ({
  origin: res.headers.get('access-control-allow-origin'),
  credentials: res.headers.get('access-control-allow-credentials'),
  vary: res.headers.get('vary'),
})

describe('group 2: Better Auth trusts a configured origin', () => {
  it('a cookie-bearing sign-out from a configured origin succeeds; from an unlisted origin it is refused (403) and the session stays', async () => {
    const { cookie } = await account()
    const evil = await w.call('/auth/sign-out', { body: {}, cookie, headers: { origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    const stillIn = await w.call('/auth/get-session', { cookie })
    expect(((await stillIn.json()) as { user?: unknown } | null)?.user).toBeTruthy()
    const ok = await w.call('/auth/sign-out', { body: {}, cookie, headers: { origin: APP } })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect(await (await w.call('/auth/get-session', { cookie })).json()).toBeNull()
  })
})

describe('group 3: credentialed CORS on /auth (D7, P1)', () => {
  it('a preflight from a configured origin is 204 with the exact headers, even with migrations pending (answered before the gates)', async () => {
    for (const inst of [w, pending]) {
      const res = await real(inst, '/auth/sign-out', {
        method: 'OPTIONS',
        headers: {
          origin: APP,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe(APP)
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST')
      expect(res.headers.get('access-control-allow-headers')).toBe(AUTH_CORS_ALLOW_HEADERS)
      expect(res.headers.get('vary')).toMatch(/origin/i)
    }
  })

  it('every response from a configured origin carries the headers: Better Auth 200 and 4xx, and the gate 503 (P1)', async () => {
    const ok = await real(w, '/auth/get-session', { headers: { origin: APP } })
    expect(ok.status).toBe(200)
    expect(cors(ok)).toMatchObject({ origin: APP, credentials: 'true' })
    expect(cors(ok).vary).toMatch(/origin/i)
    const missing = await real(w, '/auth/no-such-endpoint', { headers: { origin: APP } })
    expect(missing.status).toBeGreaterThanOrEqual(400)
    expect(missing.status).toBeLessThan(500)
    expect(cors(missing)).toMatchObject({ origin: APP, credentials: 'true' })
    const gated = await real(pending, '/auth/get-session', { headers: { origin: APP } })
    expect(gated.status).toBe(503)
    expect(cors(gated)).toMatchObject({ origin: APP, credentials: 'true' })
  })

  it('an unlisted origin and no Origin get no CORS header, as today', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, {}] as Record<string, string>[]) {
      const res = await real(w, '/auth/get-session', { headers })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    }
    const pre = await real(w, '/auth/sign-out', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(pre.headers.get('access-control-allow-origin')).toBeNull()
  })

  it("/api: a configured origin outside CORS_ALLOWED_ORIGINS gets nothing; one inside it gets today's uncredentialed answer", async () => {
    const pre = (origin: string) =>
      real(w, '/api/v1/contacts', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
      })
    const only = await pre(APP)
    expect(only.headers.get('access-control-allow-origin')).toBeNull()
    expect(only.headers.get('access-control-allow-credentials')).toBeNull()
    const both = await pre(BOTH)
    expect(both.headers.get('access-control-allow-origin')).toBe(BOTH)
    expect(both.headers.get('access-control-allow-credentials')).toBeNull()
  })
})

describe('group 4 (server): sign-in returns a callbackURL only on a trusted origin (D8)', () => {
  it('email sign-in with a callbackURL on a configured origin returns it as url and sets the session cookie', async () => {
    const { email } = await account()
    const res = await w.call('/auth/sign-in/email', {
      body: { email, password: 'a long enough password 123', callbackURL: `${APP}/` },
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { redirect?: boolean; url?: string }
    expect(body).toMatchObject({ redirect: true, url: `${APP}/` })
    expect(res.headers.get('set-cookie')).toBeTruthy()
  })

  it('email sign-in with a callbackURL on an unlisted origin is 403 and sets no cookie', async () => {
    const { email } = await account()
    const res = await w.call('/auth/sign-in/email', {
      body: { email, password: 'a long enough password 123', callbackURL: 'https://evil.example/' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('social sign-in checks callbackURL the same way: a configured origin gets a provider URL, an unlisted one is 403', async () => {
    const ok = await w.call('/auth/sign-in/social', { body: { provider: 'google', callbackURL: `${APP}/` } })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect(((await ok.json()) as { url?: string }).url).toMatch(/^https:\/\/accounts\.google\.com\//)
    const bad = await w.call('/auth/sign-in/social', {
      body: { provider: 'google', callbackURL: 'https://evil.example/' },
    })
    expect(bad.status).toBe(403)
  })
})

// A second instance: the sign-up rate limit of the first is spent by the groups above.
let wild: Workerd
beforeAll(async () => {
  wild = await startWorkerd({ bundle, bindings: BINDINGS, paired: true })
}, 120_000)
afterAll(() => wild?.dispose())
const wildAccount = async () => {
  const email = `w${n++}@auth.test`
  const { cookie } = await authKitOver(wild.call as never, BASE, []).signUp(email)
  return { email, cookie }
}

describe('[[API622]] group 4: a wildcard trusted origin, end to end in workerd (D1, D8)', () => {
  it("a cookie-bearing sign-out from a depth-2 origin passes Better Auth's origin check; the bare host is refused 403 and the session stays", async () => {
    const { cookie } = await wildAccount()
    const bare = await wild.call('/auth/sign-out', { body: {}, cookie, headers: { origin: BARE } })
    expect(bare.status).toBe(403)
    expect(
      ((await (await wild.call('/auth/get-session', { cookie })).json()) as { user?: unknown } | null)?.user,
    ).toBeTruthy()
    const ok = await wild.call('/auth/sign-out', { body: {}, cookie, headers: { origin: DEEP } })
    expect(ok.status, await ok.clone().text()).toBe(200)
  })

  it('the credentialed CORS answer echoes the depth-2 origin; the bare host gets none', async () => {
    const pre = await real(wild, '/auth/sign-out', {
      method: 'OPTIONS',
      headers: {
        origin: DEEP,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(pre.status).toBe(204)
    expect(cors(pre)).toMatchObject({ origin: DEEP, credentials: 'true' })
    const res = await real(wild, '/auth/get-session', { headers: { origin: DEEP } })
    expect(cors(res)).toMatchObject({ origin: DEEP, credentials: 'true' })
    const bare = await real(wild, '/auth/get-session', { headers: { origin: BARE } })
    expect(bare.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('D8: the session Set-Cookie has no Domain attribute with a wildcard configured', async () => {
    const { email } = await wildAccount()
    const res = await wild.call('/auth/sign-in/email', {
      body: { email, password: 'a long enough password 123', callbackURL: `${DEEP}/` },
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('better-auth')
    expect(cookie.toLowerCase()).not.toContain('domain=')
  })
})
