import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, isVibaseError } from './index.js'
import { browserSignIn, pkceChallenge, type BrowserSignInOptions, type StorageLike } from './sign-in.js'

// DX624 cycle 1 (D1 to D4, D6, D7, D5 without refresh): `browserSignIn` on injected fetch, storage and location.
const APP = 'https://app.test'
const REDIRECT = `${APP}/cb`
const CLIENT = 'client-1'

class Mem implements StorageLike {
  readonly map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  snapshot() {
    return JSON.stringify([...this.map.entries()].sort())
  }
}
const throwing: StorageLike = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('blocked')
  },
  removeItem() {
    throw new Error('blocked')
  },
}

interface Seen {
  url: string
  init: RequestInit
  kind: 'vibase' | 'metadata' | 'token' | 'other'
}
interface DeploymentOptions {
  origin?: string
  vibase?: (origin: string) => { status?: number; body?: unknown }
  metadata?: (issuer: string) => { status?: number; body?: unknown }
  token?: (form: URLSearchParams) => { status?: number; body?: unknown } | 'network'
  /** Awaited before the token endpoint answers a refresh_token grant (to hold a refresh in flight). */
  gate?: () => Promise<void>
}
const json = (r: { status?: number; body?: unknown }) =>
  new Response(JSON.stringify(r.body ?? {}), {
    status: r.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })

/** A fake Better Auth deployment: the discovery documents and a token endpoint, recording every request. */
function deployment(o: DeploymentOptions = {}) {
  const origin = o.origin ?? 'https://api.acme.example'
  const issuer = `${origin}/auth`
  const seen: Seen[] = []
  const vibaseDoc = o.vibase ?? (() => ({ body: { auth: { provider: 'better-auth', issuer, resource: origin } } }))
  const metadataDoc =
    o.metadata ??
    (() => ({
      body: {
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        code_challenge_methods_supported: ['S256'],
      },
    }))
  const handler = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const kind: Seen['kind'] =
      url === `${origin}/.well-known/vibase`
        ? 'vibase'
        : url === `${origin}/.well-known/oauth-authorization-server/auth`
          ? 'metadata'
          : url === `${issuer}/oauth2/token`
            ? 'token'
            : 'other'
    seen.push({ url, init, kind })
    if (kind === 'vibase') return json(vibaseDoc(origin))
    if (kind === 'metadata') return json(metadataDoc(issuer))
    if (kind === 'token') {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'refresh_token' && o.gate) await o.gate()
      const answer = (o.token ?? defaultToken)(form)
      if (answer === 'network') throw new TypeError('Failed to fetch')
      return json(answer)
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return {
    origin,
    issuer,
    fetch: handler,
    seen,
    of: (kind: Seen['kind']) => seen.filter((s) => s.kind === kind),
    /** Requests that went to an authorize or token endpoint (or anywhere that is not a discovery document). */
    sent: () => seen.filter((s) => s.kind === 'token' || s.kind === 'other'),
  }
}
const defaultToken = () => ({
  body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' },
})

function rig(over: Partial<BrowserSignInOptions> = {}, dep: ReturnType<typeof deployment> = deployment()) {
  const session = new Mem()
  const loc = { href: `${APP}/deals?x=1#top`, origin: APP }
  const navigated: string[] = []
  const replaced: string[] = []
  const options: BrowserSignInOptions = {
    url: `${dep.origin}/api/v1/contacts`,
    clientId: CLIENT,
    redirectUri: REDIRECT,
    fetch: dep.fetch,
    location: loc,
    navigate: (u) => navigated.push(u),
    replaceUrl: (u) => replaced.push(u),
    sessionStorage: session,
    ...over,
  }
  const s = browserSignIn(options)
  const start = async (o?: { returnTo?: string }) => {
    const before = navigated.length
    void s.signIn(o).catch(() => {})
    for (let i = 0; i < 500 && navigated.length === before; i++) await new Promise((r) => setTimeout(r, 2))
    expect(navigated.length, 'signIn did not navigate').toBe(before + 1)
    return new URL(navigated[navigated.length - 1])
  }
  const callback = (q: Record<string, string>, path = '/cb', origin = APP) => {
    loc.href = `${origin}${path}?${new URLSearchParams(q)}#frag`
    loc.origin = origin
  }
  return { s, session, loc, navigated, replaced, dep, start, callback, options }
}
/** signIn then the callback with the issued state. */
async function signedIn(over: Partial<BrowserSignInOptions> = {}, dep = deployment()) {
  const r = rig(over, dep)
  const url = await r.start()
  r.callback({ code: 'code-1', state: url.searchParams.get('state')!, iss: dep.issuer })
  const done = await r.s.handleRedirect()
  return { ...r, done }
}
const fail = async (p: Promise<unknown>) => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('the promise neither resolved nor rejected')), 1500),
  )
  const e = await Promise.race([p, timeout]).then(
    () => undefined,
    (x) => x,
  )
  expect(isVibaseError(e), String(e)).toBe(true)
  return e as { status: number; code: string; message: string }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- group 1
describe('DX624 group 1: discovery refusals (D2)', () => {
  const asVibase = (auth: unknown) => () => ({ body: { auth } })
  const good = (origin: string) => ({ provider: 'better-auth', issuer: `${origin}/auth`, resource: origin })
  const metadata = (over: Record<string, unknown>) => (issuer: string) => ({
    body: {
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      code_challenge_methods_supported: ['S256'],
      ...over,
    },
  })
  const cases: [string, string, DeploymentOptions][] = [
    [
      'unsupported_provider',
      'a Clerk document',
      { vibase: asVibase({ provider: 'clerk', issuer: 'https://clerk.example' }) },
    ],
    ['unsupported_provider', 'no auth at all', { vibase: asVibase(null) }],
    [
      'issuer_mismatch',
      'metadata naming another issuer',
      { metadata: metadata({ issuer: 'https://other.example/auth' }) },
    ],
    [
      'endpoint_origin',
      'authorize on another origin',
      { metadata: metadata({ authorization_endpoint: 'https://evil.test/oauth2/authorize' }) },
    ],
    [
      'endpoint_origin',
      'token on another origin',
      { metadata: metadata({ token_endpoint: 'https://evil.test/oauth2/token' }) },
    ],
    ['discovery_failed', 'no S256', { metadata: metadata({ code_challenge_methods_supported: ['plain'] }) }],
    ['discovery_failed', 'a 503 vibase document', { vibase: () => ({ status: 503, body: {} }) }],
    ['discovery_failed', 'a 404 metadata document', { metadata: () => ({ status: 404, body: {} }) }],
    [
      'insecure_issuer',
      'plain http on a non-loopback host',
      {
        origin: 'http://api.acme.example',
        vibase: (o) => ({ body: { auth: good(o) } }),
      },
    ],
  ]
  it.each(cases)(
    '%s: %s, on signIn and on handleRedirect, sends nothing to an endpoint and stores nothing',
    async (code, _n, o) => {
      const dep = deployment(o)
      const r = rig({}, dep)
      const e = await fail(r.s.signIn())
      expect(e.code).toBe(code)
      expect(r.navigated).toEqual([])
      expect(r.session.map.size).toBe(0)
      expect(dep.sent()).toEqual([])
      // the callback path discovers too, and is refused the same way before any token request
      r.callback({ code: 'c', state: 's' })
      r.session.setItem(
        `vibase.sign-in:${dep.origin}:${CLIENT}:pending`,
        JSON.stringify({ state: 's', verifier: 'v'.repeat(43), redirect_uri: REDIRECT, return_to: '/', created_at: 1 }),
      )
      const e2 = await fail(r.s.handleRedirect())
      expect(e2.code).toBe(code)
      expect(dep.sent()).toEqual([])
      expect(r.navigated).toEqual([])
      expect(r.s.isSignedIn()).toBe(false)
    },
  )

  it('every discovery request is credentials: omit', async () => {
    const dep = deployment()
    await rig({}, dep).start()
    expect(dep.of('vibase')).toHaveLength(1)
    expect(dep.of('metadata')).toHaveLength(1)
    for (const call of [...dep.of('vibase'), ...dep.of('metadata')]) expect(call.init.credentials).toBe('omit')
  })

  it.each(['http://localhost:8787', 'http://127.0.0.1:8787'])('loopback %s passes over plain http', async (origin) => {
    const dep = deployment({ origin })
    const url = await rig({}, dep).start()
    expect(url.origin).toBe(origin)
  })

  it('a successful discovery is fetched once across verbs; a failed one is retried on the next call', async () => {
    const dep = deployment()
    const r = rig({}, dep)
    await r.start()
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: dep.issuer })
    await r.s.handleRedirect()
    expect(dep.of('vibase')).toHaveLength(1)
    expect(dep.of('metadata')).toHaveLength(1)

    let calls = 0
    const flaky = deployment({
      vibase: () => (++calls === 1 ? { status: 503, body: {} } : { body: { auth: good('https://api.acme.example') } }),
    })
    const f = rig({}, flaky)
    expect((await fail(f.s.signIn())).code).toBe('discovery_failed')
    await f.start()
    expect(flaky.of('vibase')).toHaveLength(2)
  })

  it('a network failure during discovery is network_error', async () => {
    const r = rig({
      fetch: (async () => {
        throw new TypeError('offline')
      }) as typeof fetch,
    })
    expect((await fail(r.s.signIn())).code).toBe('network_error')
  })
})

// ---------------------------------------------------------------- group 2
describe('DX624 group 2: signIn builds exactly the spec request (D3)', () => {
  it('the challenge is S256 of the verifier: the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('carries exactly the spec parameters; verifier is 43 chars and its challenge is in the URL; state is fresh per call', async () => {
    const dep = deployment()
    const r = rig({}, dep)
    const a = await r.start()
    expect([...a.searchParams.keys()].sort()).toEqual(
      [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'redirect_uri',
        'resource',
        'response_type',
        'state',
      ].sort(),
    )
    expect(a.origin + a.pathname).toBe(`${dep.issuer}/oauth2/authorize`)
    expect(a.searchParams.get('response_type')).toBe('code')
    expect(a.searchParams.get('client_id')).toBe(CLIENT)
    expect(a.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(a.searchParams.get('code_challenge_method')).toBe('S256')
    expect(a.searchParams.get('resource')).toBe(dep.origin)
    const pending = JSON.parse([...r.session.map.values()][0])
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await pkceChallenge(pending.verifier)).toBe(a.searchParams.get('code_challenge'))
    expect(pending.state).toBe(a.searchParams.get('state'))
    const b = await r.start()
    expect(b.searchParams.get('state')).not.toBe(a.searchParams.get('state'))
    expect(b.searchParams.get('code_challenge')).not.toBe(a.searchParams.get('code_challenge'))
  })

  it('scope: omitted means no scope parameter; given means openid offline_access first, de-duplicated', async () => {
    expect((await rig().start()).searchParams.has('scope')).toBe(false)
    const given = await rig({ scopes: ['contacts:read', 'openid', 'contacts:read'] }).start()
    expect(given.searchParams.get('scope')).toBe('openid offline_access contacts:read')
  })

  it.each(['local', 'memory'] as const)(
    'the pending record is in sessionStorage even when the token store is %s; a second signIn replaces the first',
    async (store) => {
      const local = new Mem()
      vi.stubGlobal('localStorage', local)
      const r = rig({ storage: store })
      await r.start()
      expect(r.session.map.size).toBe(1)
      expect(local.map.size).toBe(0)
      const first = [...r.session.map.values()][0]
      await r.start()
      expect(r.session.map.size).toBe(1)
      expect([...r.session.map.values()][0]).not.toBe(first)
    },
  )

  it('returnTo defaults to path + query + hash and is kept on the pending record', async () => {
    const r = rig()
    await r.start()
    expect(JSON.parse([...r.session.map.values()][0])).toMatchObject({
      return_to: '/deals?x=1#top',
      redirect_uri: REDIRECT,
    })
    const r2 = rig()
    await r2.start({ returnTo: `${APP}/boards/7` })
    expect(JSON.parse([...r2.session.map.values()][0]).return_to).toBe('/boards/7')
  })

  it.each(['https://evil.test/x', '//evil.test/x', '/\\evil.test/x', 'http://app.test/x'])(
    'returnTo %s is invalid_return_to: nothing stored, nothing navigated',
    async (returnTo) => {
      const r = rig()
      const e = await fail(r.s.signIn({ returnTo }))
      expect(e.code).toBe('invalid_return_to')
      expect(r.session.map.size).toBe(0)
      expect(r.navigated).toEqual([])
      expect(r.dep.seen).toEqual([])
    },
  )
})

// ---------------------------------------------------------------- group 3
describe('DX624 group 3: handleRedirect checks before it sends (D4)', () => {
  it.each([
    ['another path', { code: 'c', state: 's' }, '/other', APP],
    ['another origin', { code: 'c', state: 's' }, '/cb', 'https://evil.test'],
    ['neither code nor error', { foo: '1' }, '/cb', APP],
  ])('off the callback (%s): null, no request, storage untouched', async (_n, q, path, origin) => {
    const r = rig()
    await r.start()
    const before = r.session.snapshot()
    const calls = r.dep.seen.length
    r.callback(q, path, origin)
    expect(await r.s.handleRedirect()).toBeNull()
    expect(r.dep.seen.length).toBe(calls)
    expect(r.session.snapshot()).toBe(before)
    expect(r.replaced).toEqual([])
  })

  it('no pending record, or another state: state_mismatch, nothing sent at all, the address bar cleaned', async () => {
    const dep = deployment()
    const r = rig({}, dep)
    r.callback({ code: 'c', state: 'whatever' })
    expect((await fail(r.s.handleRedirect())).code).toBe('state_mismatch')
    expect(dep.seen).toEqual([])
    expect(r.replaced).toEqual(['/cb#frag'])

    const r2 = rig({}, dep)
    await r2.start()
    r2.callback({ code: 'c', state: 'forged' })
    expect((await fail(r2.s.handleRedirect())).code).toBe('state_mismatch')
    expect(dep.sent()).toEqual([])
    expect(r2.session.map.size).toBe(0)
  })

  it('an iss other than the issuer is issuer_mismatch with no token request; an absent iss is accepted', async () => {
    const dep = deployment()
    const r = rig({}, dep)
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: 'https://evil.test/auth' })
    expect((await fail(r.s.handleRedirect())).code).toBe('issuer_mismatch')
    expect(dep.of('token')).toHaveLength(0)
    expect(r.session.map.size).toBe(0)

    const ok = rig({}, dep)
    const u2 = await ok.start()
    ok.callback({ code: 'c', state: u2.searchParams.get('state')! })
    expect(await ok.s.handleRedirect()).toEqual({ returnTo: '/deals?x=1#top' })
  })

  it('error: authorization_failed carrying the error and description; record gone; callback stripped', async () => {
    const r = rig()
    const url = await r.start()
    r.callback({
      error: 'access_denied',
      error_description: 'nope',
      state: url.searchParams.get('state')!,
      iss: r.dep.issuer,
    })
    const e = await fail(r.s.handleRedirect())
    expect(e.code).toBe('authorization_failed')
    expect(e.message).toContain('access_denied')
    expect(e.message).toContain('nope')
    expect(r.dep.of('token')).toHaveLength(0)
    expect(r.session.map.size).toBe(0)
    expect(r.replaced).toEqual(['/cb#frag'])
  })

  it('a replayed callback after a failed exchange is state_mismatch (the pending record is deleted before the exchange)', async () => {
    const dep = deployment({
      token: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'used' } }),
    })
    const r = rig({}, dep)
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: dep.issuer })
    expect((await fail(r.s.handleRedirect())).code).toBe('invalid_grant')
    expect(dep.of('token')).toHaveLength(1)
    expect((await fail(r.s.handleRedirect())).code).toBe('state_mismatch')
    expect(dep.of('token')).toHaveLength(1)
  })

  it('the record is deleted before the exchange starts, not after it', async () => {
    let during: number | undefined
    const dep = deployment({ token: () => defaultToken() })
    const r = rig({}, dep)
    const url = await r.start()
    const wrapped = dep.fetch
    const s = browserSignIn({
      ...r.options,
      fetch: (async (u: RequestInfo | URL, i?: RequestInit) => {
        if (String(u).endsWith('/oauth2/token')) during = r.session.map.size
        return wrapped(u, i)
      }) as typeof fetch,
    })
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: dep.issuer })
    await s.handleRedirect()
    expect(during).toBe(0)
  })

  it('strips code, state, iss, error and error_description on success and keeps other parameters and the hash', async () => {
    const r = rig()
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: r.dep.issuer, keep: '1' })
    await r.s.handleRedirect()
    expect(r.replaced).toEqual(['/cb?keep=1#frag'])
  })
})

// ---------------------------------------------------------------- group 4
describe('DX624 group 4: the code exchange and the token record (D4, D5 per P1)', () => {
  it('POSTs a form with exactly the six fields, credentials omit and no Authorization; resolves returnTo', async () => {
    const dep = deployment()
    const r = rig({}, dep)
    const url = await r.start()
    const pending = JSON.parse([...r.session.map.values()][0])
    r.callback({ code: 'code-9', state: url.searchParams.get('state')!, iss: dep.issuer })
    expect(await r.s.handleRedirect()).toEqual({ returnTo: '/deals?x=1#top' })
    const [req] = dep.of('token')
    expect(req.init.method).toBe('POST')
    expect(req.init.credentials).toBe('omit')
    const headers = new Headers(req.init.headers)
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(headers.has('authorization')).toBe(false)
    const form = new URLSearchParams(String(req.init.body))
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-9',
      code_verifier: pending.verifier,
      redirect_uri: REDIRECT,
      client_id: CLIENT,
      resource: dep.origin,
    })
  })

  it('a 200 with access_token and expires_in is stored with expires_at = now + expires_in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const { s, session } = await signedIn()
    expect(s.isSignedIn()).toBe(true)
    expect(await s.token()).toBe('at-1')
    const stored = [...session.map.entries()].find(([k]) => k.endsWith(':token'))
    expect(JSON.parse(stored![1])).toMatchObject({
      access_token: 'at-1',
      expires_at: 1_000_000 + 3_600_000,
      refresh_token: 'rt-1',
    })
  })

  it.each([
    ['no access_token', { expires_in: 3600 }],
    ['no expires_in', { access_token: 'x' }],
    ['a non-numeric expires_in', { access_token: 'x', expires_in: 'soon' }],
    ['an empty access_token', { access_token: '', expires_in: 3600 }],
  ])('a 200 with %s rejects and stores nothing', async (_n, body) => {
    const dep = deployment({ token: () => ({ body }) })
    const r = rig({}, dep)
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: dep.issuer })
    const e = await fail(r.s.handleRedirect())
    expect(e).toMatchObject({ status: 200, code: 'invalid_response' })
    expect(r.s.isSignedIn()).toBe(false)
    expect([...r.session.map.keys()].filter((k) => k.endsWith(':token'))).toEqual([])
  })

  it('a 400 with an OAuth error rejects with that code and status; nothing stored; address bar cleaned', async () => {
    const dep = deployment({
      token: () => ({ status: 400, body: { error: 'invalid_client', error_description: 'gone' } }),
    })
    const r = rig({}, dep)
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: dep.issuer })
    expect(await fail(r.s.handleRedirect())).toMatchObject({ status: 400, code: 'invalid_client' })
    expect(r.s.isSignedIn()).toBe(false)
    expect(r.replaced).toEqual(['/cb#frag'])
  })

  it('a network failure at the token endpoint is network_error', async () => {
    const dep = deployment({ token: () => 'network' })
    const r = rig({}, dep)
    const url = await r.start()
    r.callback({ code: 'c', state: url.searchParams.get('state')!, iss: dep.issuer })
    expect(await fail(r.s.handleRedirect())).toMatchObject({ status: 0, code: 'network_error' })
  })

  it('token(): more than 60 s left returns the token with no request; exactly 60 s left refreshes (boundary kept from cycle 1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const dep = deployment({
      token: (f) =>
        f.get('grant_type') === 'refresh_token'
          ? { body: { access_token: 'at-2', expires_in: 3600 } }
          : { body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } },
    })
    const { s } = await signedIn({}, dep)
    const sent = dep.of('token').length
    vi.setSystemTime(3_600_000 - 60_001)
    expect(await s.token()).toBe('at-1')
    expect(dep.of('token').length).toBe(sent)
    vi.setSystemTime(3_600_000 - 60_000)
    expect(await s.token()).toBe('at-2')
    expect(dep.of('token').length).toBe(sent + 1)
  })

  it('signed out: token() is null, isSignedIn() false, and createClient answers 401 no_credential with no request', async () => {
    const r = rig()
    expect(await r.s.token()).toBeNull()
    expect(r.s.isSignedIn()).toBe(false)
    const calls: string[] = []
    const client = createClient({
      url: r.dep.origin,
      auth: r.s.token,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u))
        return new Response('{}')
      }) as typeof fetch,
    })
    expect(await fail(client.contacts.list())).toMatchObject({ status: 401, code: 'no_credential' })
    expect(calls).toEqual([])
  })

  it('signed in: createClient({ auth: signIn.token }) sends the access token as a bearer', async () => {
    const { s, dep } = await signedIn()
    const auths: (string | null)[] = []
    const client = createClient({
      url: dep.origin,
      auth: s.token,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        auths.push(new Headers(init?.headers).get('authorization'))
        return new Response(JSON.stringify({ data: [], next_cursor: null }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    await client.contacts.list()
    expect(auths).toEqual(['Bearer at-1'])
  })
})

// ---------------------------------------------------------------- group 5
describe('DX624 group 5: storage, sign-out and import inertness (D6, D7, D1)', () => {
  it('session (default, injected), local, memory and a Storage-like object each round-trip the record', async () => {
    const local = new Mem()
    vi.stubGlobal('localStorage', local)
    const custom = new Mem()
    for (const form of [undefined, 'session'] as const) {
      const { s, session } = await signedIn(form === undefined ? {} : { storage: form })
      expect(await s.token()).toBe('at-1')
      expect([...session.map.keys()].some((k) => k.endsWith(':token'))).toBe(true)
    }
    const l = await signedIn({ storage: 'local' })
    expect(await l.s.token()).toBe('at-1')
    expect([...local.map.keys()].filter((k) => k.endsWith(':token'))).toHaveLength(1)
    expect([...l.session.map.keys()].some((k) => k.endsWith(':token'))).toBe(false)
    const m = await signedIn({ storage: 'memory' })
    expect(await m.s.token()).toBe('at-1')
    expect([...m.session.map.keys()].some((k) => k.endsWith(':token'))).toBe(false)
    const c = await signedIn({ storage: custom })
    expect(await c.s.token()).toBe('at-1')
    expect([...custom.map.keys()].filter((k) => k.endsWith(':token'))).toHaveLength(1)
  })

  it('two clients on one storage do not see each other; sign-out of one leaves the other', async () => {
    const shared = new Mem()
    const dep = deployment()
    const a = await signedIn({ clientId: 'client-A', storage: shared, sessionStorage: shared }, dep)
    const b = rig({ clientId: 'client-B', storage: shared, sessionStorage: shared }, dep)
    expect(a.s.isSignedIn()).toBe(true)
    expect(b.s.isSignedIn()).toBe(false)
    expect(await b.s.token()).toBeNull()
    b.s.signOut()
    expect(a.s.isSignedIn()).toBe(true)
    // the same client id on another deployment is another record too
    const other = deployment({ origin: 'https://api.other.example' })
    const o = rig({ clientId: 'client-A', storage: shared, sessionStorage: shared }, other)
    expect(o.s.isSignedIn()).toBe(false)
  })

  it('an unparseable record reads as signed out and is removed', async () => {
    const { s, session } = await signedIn()
    const key = [...session.map.keys()].find((k) => k.endsWith(':token'))!
    session.setItem(key, '{not json')
    expect(s.isSignedIn()).toBe(false)
    expect(session.getItem(key)).toBeNull()
    session.setItem(key, JSON.stringify({ access_token: 5 }))
    expect(await s.token()).toBeNull()
    expect(session.getItem(key)).toBeNull()
  })

  it('a storage whose accessors throw falls back to memory and the flow still completes', async () => {
    const { s, done } = await signedIn({ storage: throwing, sessionStorage: throwing })
    expect(done).toEqual({ returnTo: '/deals?x=1#top' })
    expect(s.isSignedIn()).toBe(true)
    expect(await s.token()).toBe('at-1')
    s.signOut()
    expect(s.isSignedIn()).toBe(false)
  })

  it('signOut removes the token and pending records and calls fetch zero times', async () => {
    const dep = deployment()
    const { s, session } = await signedIn({}, dep)
    const r2 = rig({ sessionStorage: session }, dep)
    await r2.start() // a pending record beside the token record
    expect(session.map.size).toBe(2)
    const calls = dep.seen.length
    r2.s.signOut()
    expect(session.map.size).toBe(0)
    expect(dep.seen.length).toBe(calls)
    expect(s.isSignedIn()).toBe(false)
  })

  it('importing the entry and calling browserSignIn(...) reads no browser global', async () => {
    const touched: string[] = []
    const names = ['location', 'history', 'sessionStorage', 'localStorage', 'document', 'window']
    const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const)
    for (const n of names)
      Object.defineProperty(globalThis, n, { configurable: true, get: () => (touched.push(n), undefined) })
    try {
      vi.resetModules()
      const mod = await import('./index.js')
      mod.browserSignIn({
        url: 'https://api.acme.example',
        clientId: 'c',
        redirectUri: REDIRECT,
        fetch: (async () => new Response('{}')) as typeof fetch,
      })
    } finally {
      for (const [n, d] of saved) {
        if (d) Object.defineProperty(globalThis, n, d)
        else delete (globalThis as Record<string, unknown>)[n]
      }
    }
    expect(touched).toEqual([])
  })

  it('with no browser globals at all the verbs still do not crash on the safe paths', async () => {
    vi.stubGlobal('sessionStorage', undefined)
    const s = browserSignIn({
      url: 'https://api.acme.example',
      clientId: 'c',
      redirectUri: REDIRECT,
      location: { href: `${APP}/x`, origin: APP },
    })
    expect(s.isSignedIn()).toBe(false)
    expect(await s.handleRedirect()).toBeNull()
    s.signOut()
  })
})

// ---------------------------------------------------------------- DX636 refresh groups
const TOKEN_KEY = `vibase.sign-in:https://api.acme.example:${CLIENT}:token`
const NOW = 5_000_000
/** A sign-in whose storage already holds a token record (no sign-in flow), with the clock fixed at NOW. */
function seeded(record: Record<string, unknown> | null, dep = deployment(), over: Partial<BrowserSignInOptions> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  const r = rig(over, dep)
  if (record) r.session.setItem(TOKEN_KEY, JSON.stringify(record))
  return r
}
const inside = { access_token: 'at-old', expires_at: NOW + 30_000, refresh_token: 'rt-old' }
const refreshAnswer = (body: Record<string, unknown> = { access_token: 'at-new', expires_in: 3600 }) => ({
  token: () => ({ body }),
})
const storedToken = (session: Mem) => JSON.parse(session.getItem(TOKEN_KEY) ?? 'null')

describe('DX636 group 1: the refresh request and what it stores (D5)', () => {
  it('inside the margin: one form POST of exactly five fields, credentials omit, redirect error; the answer is stored and returned', async () => {
    const dep = deployment(refreshAnswer())
    const { s, session } = seeded(inside, dep)
    expect(await s.token()).toBe('at-new')
    const reqs = dep.of('token')
    expect(reqs).toHaveLength(1)
    expect(reqs[0].url).toBe(`${dep.issuer}/oauth2/token`)
    expect(reqs[0].init.method).toBe('POST')
    expect(reqs[0].init.credentials).toBe('omit')
    expect(reqs[0].init.redirect).toBe('error')
    const headers = new Headers(reqs[0].init.headers)
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(headers.has('authorization')).toBe(false)
    expect(Object.fromEntries(new URLSearchParams(String(reqs[0].init.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      client_id: CLIENT,
      resource: dep.origin,
    })
    expect(storedToken(session)).toEqual({
      access_token: 'at-new',
      expires_at: NOW + 3_600_000,
      refresh_token: 'rt-old',
    })
    expect(await s.token()).toBe('at-new') // now outside the margin: no second request
    expect(dep.of('token')).toHaveLength(1)
  })

  it('a rotated refresh_token replaces the old one, and the next refresh sends it', async () => {
    const dep = deployment(refreshAnswer({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 100 }))
    const { s, session } = seeded(inside, dep)
    await s.token()
    expect(storedToken(session).refresh_token).toBe('rt-new')
    await s.token() // 100 s left is outside the margin
    vi.setSystemTime(NOW + 50_000)
    await s.token() // 50 s left
    const forms = dep.of('token').map((r) => new URLSearchParams(String(r.init.body)))
    expect(forms.map((f) => f.get('refresh_token'))).toEqual(['rt-old', 'rt-new'])
  })

  it('an answer without a refresh_token keeps the old one', async () => {
    const { s, session } = seeded(inside, deployment(refreshAnswer()))
    await s.token()
    expect(storedToken(session).refresh_token).toBe('rt-old')
  })

  it('more than 60 s left: no request and the record is untouched', async () => {
    const dep = deployment(refreshAnswer())
    const { s, session } = seeded({ ...inside, expires_at: NOW + 60_001 }, dep)
    const snapshot = session.snapshot()
    expect(await s.token()).toBe('at-old')
    expect(dep.seen).toEqual([])
    expect(session.snapshot()).toBe(snapshot)
  })

  it('an already expired token with a refresh token refreshes too', async () => {
    const dep = deployment(refreshAnswer())
    const { s } = seeded({ ...inside, expires_at: NOW - 10_000 }, dep)
    expect(await s.token()).toBe('at-new')
  })
})

describe('DX636 group 2: single-flight and its races (P3, P4)', () => {
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2))
    expect(cond(), 'the refresh request never arrived').toBe(true)
  }
  const gated = () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    return { release, gate: () => held }
  }

  it('N concurrent token() calls send one request and all resolve the same token', async () => {
    const g = gated()
    const dep = deployment({ ...refreshAnswer(), gate: g.gate })
    const { s } = seeded(inside, dep)
    const calls = [s.token(), s.token(), s.token(), s.token(), s.token()]
    await until(() => dep.of('token').length > 0)
    g.release()
    expect(await Promise.all(calls)).toEqual(Array(5).fill('at-new'))
    expect(dep.of('token')).toHaveLength(1)
  })

  it('a failing in-flight refresh rejects every waiter, is not cached, and the next call sends a new request', async () => {
    const g = gated()
    let calls = 0
    const dep = deployment({
      gate: g.gate,
      token: () => (++calls === 1 ? { status: 500, body: {} } : { body: { access_token: 'at-new', expires_in: 3600 } }),
    })
    const { s } = seeded(inside, dep)
    const waiters = [s.token(), s.token(), s.token()].map((p) => fail(p))
    await until(() => dep.of('token').length > 0)
    g.release()
    for (const e of await Promise.all(waiters)) expect(e).toMatchObject({ status: 500 })
    expect(dep.of('token')).toHaveLength(1)
    expect(await s.token()).toBe('at-new')
    expect(dep.of('token')).toHaveLength(2)
  })

  it('a 400 in flight resolves every waiter null, and nothing stays cached', async () => {
    const g = gated()
    const dep = deployment({ gate: g.gate, token: () => ({ status: 400, body: { error: 'invalid_grant' } }) })
    const { s } = seeded(inside, dep)
    const calls = [s.token(), s.token()]
    await until(() => dep.of('token').length > 0)
    g.release()
    expect(await Promise.all(calls)).toEqual([null, null])
    expect(await s.token()).toBeNull()
    expect(dep.of('token')).toHaveLength(1) // signed out now: nothing more to send
  })

  it('signOut() while a refresh is in flight: the late answer is dropped, that call is null, no record remains', async () => {
    const g = gated()
    const dep = deployment({ ...refreshAnswer(), gate: g.gate })
    const { s, session } = seeded(inside, dep)
    const p = s.token()
    await until(() => dep.of('token').length > 0)
    s.signOut()
    g.release()
    expect(await p).toBeNull()
    expect(s.isSignedIn()).toBe(false)
    expect([...session.map.keys()].filter((k) => k.endsWith(':token'))).toEqual([])
  })

  it('a different record stored while a refresh is in flight (a new sign-in) is left alone, and the late answer is dropped', async () => {
    const g = gated()
    const dep = deployment({ ...refreshAnswer(), gate: g.gate })
    const { s, session } = seeded(inside, dep)
    const p = s.token()
    await until(() => dep.of('token').length > 0)
    const other = { access_token: 'at-other', expires_at: NOW + 3_600_000, refresh_token: 'rt-other' }
    session.setItem(TOKEN_KEY, JSON.stringify(other))
    g.release()
    expect(await p).toBeNull()
    expect(storedToken(session)).toEqual(other)
  })
})

describe('DX636 group 3: the refresh outcome matrix (D5, P2, P5)', () => {
  it.each([
    [400, { error: 'invalid_grant' }],
    [401, { error: 'invalid_client' }],
  ])('refresh %i answers null and clears the record', async (status, body) => {
    const dep = deployment({ token: () => ({ status, body }) })
    const { s, session } = seeded(inside, dep)
    expect(await s.token()).toBeNull()
    expect(s.isSignedIn()).toBe(false)
    expect(session.getItem(TOKEN_KEY)).toBeNull()
    expect(dep.of('token')).toHaveLength(1)
  })

  it.each([
    [500, {}, 'http_500'],
    [503, { error: 'temporarily_unavailable' }, 'temporarily_unavailable'],
    [429, {}, 'http_429'],
  ])('refresh %i rejects with that status and keeps the record byte-identical', async (status, body, code) => {
    const dep = deployment({ token: () => ({ status, body }) })
    const { s, session } = seeded(inside, dep)
    const snapshot = session.snapshot()
    expect(await fail(s.token())).toMatchObject({ status, code })
    expect(session.snapshot()).toBe(snapshot)
    expect(s.isSignedIn()).toBe(true)
  })

  it('a throwing fetch rejects network_error (status 0) and keeps the record', async () => {
    const { s, session } = seeded(inside, deployment({ token: () => 'network' }))
    const snapshot = session.snapshot()
    expect(await fail(s.token())).toMatchObject({ status: 0, code: 'network_error' })
    expect(session.snapshot()).toBe(snapshot)
  })

  it('a discovery failure rejects and keeps the record, and a later call retries discovery', async () => {
    let up = false
    const dep = deployment({
      vibase: (origin) =>
        up
          ? { body: { auth: { provider: 'better-auth', issuer: `${origin}/auth`, resource: origin } } }
          : { status: 503, body: {} },
      ...refreshAnswer(),
    })
    const { s, session } = seeded(inside, dep)
    const snapshot = session.snapshot()
    expect(await fail(s.token())).toMatchObject({ code: 'discovery_failed' })
    expect(session.snapshot()).toBe(snapshot)
    expect(dep.of('token')).toHaveLength(0)
    up = true
    expect(await s.token()).toBe('at-new')
    expect(dep.of('vibase')).toHaveLength(2)
  })

  it.each([
    ['no access_token', { expires_in: 3600 }],
    ['an empty access_token', { access_token: '', expires_in: 3600 }],
    ['no expires_in', { access_token: 'x' }],
    ['a non-numeric expires_in', { access_token: 'x', expires_in: 'soon' }],
  ])('a 200 with %s rejects invalid_response (status 200) and keeps the record', async (_n, body) => {
    const { s, session } = seeded(inside, deployment({ token: () => ({ body }) }))
    const snapshot = session.snapshot()
    expect(await fail(s.token())).toMatchObject({ status: 200, code: 'invalid_response' })
    expect(session.snapshot()).toBe(snapshot)
  })

  it('P2: expired with no refresh token resolves null, sends nothing and clears the record', async () => {
    const dep = deployment(refreshAnswer())
    const { s, session } = seeded({ access_token: 'at-old', expires_at: NOW + 30_000 }, dep)
    expect(await s.token()).toBeNull()
    expect(dep.seen).toEqual([])
    expect(s.isSignedIn()).toBe(false)
    expect(session.getItem(TOKEN_KEY)).toBeNull()
  })

  it('P2: more than 60 s left with no refresh token is returned as before', async () => {
    const { s } = seeded({ access_token: 'at-old', expires_at: NOW + 120_000 }, deployment())
    expect(await s.token()).toBe('at-old')
    expect(s.isSignedIn()).toBe(true)
  })
})

describe('DX636 group 4: a 401 from the API through createClient (D8)', () => {
  it('a valid token and an API 401: rejects VibaseError 401, one request only, the record untouched', async () => {
    const dep = deployment()
    const r = seeded({ access_token: 'at-old', expires_at: NOW + 3_600_000, refresh_token: 'rt-old' }, dep)
    const snapshot = r.session.snapshot()
    const calls: string[] = []
    const client = createClient({
      url: dep.origin,
      auth: r.s.token,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u))
        return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    expect(await fail(client.contacts.list())).toMatchObject({ status: 401, code: 'unauthorized' })
    expect(calls).toHaveLength(1)
    expect(dep.seen).toEqual([])
    expect(r.session.snapshot()).toBe(snapshot)
    expect(r.s.isSignedIn()).toBe(true)
  })
})
