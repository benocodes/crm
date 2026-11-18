import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { registrationScopes, seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry, defaultGrantScopes, grantableScopes } from '@vibase/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[CORE330]]: an /oauth2/authorize request that names no scope asks for, and is granted, the default-grant set only (not the client's stored ceiling), through the composed Worker in workerd
// from registration to token. Sets are compared whole: `toContain` passes with the ceiling too.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableScopes(declared)
const DEFAULTS = registrationScopes(declared, grantable, defaultGrantScopes(declared)).defaults
const MCP = `${BASE}/mcp`
const REDIRECT = 'http://127.0.0.1:33418/cb'
const PASSWORD = 'a long enough password 123'
const verifier = 'v'.repeat(60)
let n = 0
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 250) + 1}` })
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>
const set = (s: string | null | undefined) => (s ?? '').split(' ').filter(Boolean).sort()

let bundle: Bundle
let w: Workerd
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({
    bundle,
    bindings: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1' },
    paired: true,
  })
  await seedFirstPartyClient(w.control as never, { baseURL: BASE })
  // vibase-cli is a device-grant client with no redirect URI; to authorize it at all, give the seeded row (scopes stay NULL) a redirect and the code grant.
  await w.control
    .prepare("update auth_oauth_clients set redirect_uris = ?, grant_types = ? where client_id = 'vibase-cli'")
    .bind(JSON.stringify([REDIRECT]), JSON.stringify(['authorization_code', 'refresh_token']))
    .run()
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

const call = (path: string, init: { body?: unknown; form?: boolean; cookie?: string; method?: string } = {}) =>
  w.call(path, { ...init, headers: ip() })
const signUp = (email: string) => authKitOver(call as never, BASE, declared).signUp(email)

async function authorizeRedirect(path: string, cookie?: string): Promise<URL> {
  const res = (await w.mf.dispatchFetch(BASE + path, {
    redirect: 'manual',
    headers: { origin: BASE, ...ip(), ...(cookie ? { cookie } : {}) },
  })) as unknown as Response
  const raw =
    res.status === 302 ? res.headers.get('location') : ((await res.json()) as { redirect?: boolean; url?: string }).url
  expect(raw, `authorize answered ${res.status}`).toBeTruthy()
  return new URL(raw!, BASE)
}

const registerNoScope = async () => {
  const res = await call('/auth/oauth2/register', {
    body: {
      client_name: 'Claude Web',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [REDIRECT],
    },
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

/** `scope`: undefined = no parameter; otherwise the raw value. */
const authorizeUrl = (clientId: string, scope?: string) =>
  `/auth/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    ...(scope === undefined ? {} : { scope }),
    state: 'st',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: MCP,
  }).toString()}`

/** Authorize, in the given session state, to the consent step and on to a token: the scope consent was asked for and the access token's. */
async function toToken(
  clientId: string,
  scope: string | undefined,
  state: 'signed-in' | 'signed-out',
  email: string,
): Promise<{ asked: string[]; granted: string[] }> {
  const { cookie } = await signUp(email)
  let consent: URL
  let sessionCookie = cookie
  if (state === 'signed-in') {
    consent = await authorizeRedirect(authorizeUrl(clientId, scope), cookie)
  } else {
    const loc = await authorizeRedirect(authorizeUrl(clientId, scope))
    expect(loc.pathname).toBe('/sign-in')
    const signedIn = await call('/auth/sign-in/email', {
      body: { email, password: PASSWORD, oauth_query: loc.search.slice(1) },
    })
    expect(signedIn.status, await signedIn.clone().text()).toBe(200)
    sessionCookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    consent = new URL(((await signedIn.json()) as { url: string }).url, BASE)
  }
  expect(consent.pathname).toBe('/consent')
  const asked = set(consent.searchParams.get('scope'))
  const accepted = await call('/auth/oauth2/consent', {
    cookie: sessionCookie,
    body: { accept: true, oauth_query: consent.search.slice(1) },
  })
  expect(accepted.status, await accepted.clone().text()).toBe(200)
  const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get('code')!
  const tok = await call('/auth/oauth2/token', {
    form: true,
    body: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
      resource: MCP,
    },
  })
  expect(tok.status, await tok.clone().text()).toBe(200)
  const granted = set(decode(((await tok.json()) as { access_token: string }).access_token).scope)
  return { asked, granted }
}

describe('group 1: a scope-less authorize is asked for and granted exactly the default set', () => {
  it('the default set is not the ceiling (the cases below mean something)', () => {
    expect(DEFAULTS).toContain('offline_access')
    expect(DEFAULTS).toContain('contacts:write')
    expect(DEFAULTS).not.toContain('audit:read')
    expect(grantable).toContain('audit:read')
  })

  const clients = ['dcr', 'vibase-cli'] as const
  const states = ['signed-in', 'signed-out'] as const
  const forms: Array<[string, string | undefined]> = [
    ['absent', undefined],
    ['blank (scope=)', ''],
    ['whitespace only', '   '],
  ]
  for (const client of clients)
    for (const state of states)
      for (const [formName, scope] of forms)
        it(`${client}, ${state}, scope ${formName}`, async () => {
          const id = client === 'dcr' ? await registerNoScope() : 'vibase-cli'
          const { asked, granted } = await toToken(id, scope, state, `g1-${client}-${state}-${formName.length}@x.test`)
          expect(asked).toEqual([...DEFAULTS].sort())
          expect(granted).toEqual([...DEFAULTS].sort())
          expect(granted).not.toContain('audit:read')
        })
})

describe('group 1b: a scope-less POST authorize (form body) gets the default set', () => {
  for (const [formName, scope] of [
    ['absent', undefined],
    ['blank', ''],
  ] as Array<[string, string | undefined]>)
    it(`dcr, signed-in, POST body, scope ${formName}`, async () => {
      const id = await registerNoScope()
      const { cookie } = await signUp(`g1b-${formName}@x.test`)
      const params = new URL(authorizeUrl(id, scope), BASE).searchParams
      const res = (await w.mf.dispatchFetch(`${BASE}/auth/oauth2/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: BASE, ...ip(), cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })) as unknown as Response
      const raw = res.status === 302 ? res.headers.get('location') : ((await res.json()) as { url?: string }).url
      expect(raw, `authorize answered ${res.status}`).toBeTruthy()
      const consent = new URL(raw!, BASE)
      expect(consent.pathname).toBe('/consent')
      expect(set(consent.searchParams.get('scope'))).toEqual([...DEFAULTS].sort())
      const accepted = await call('/auth/oauth2/consent', {
        cookie,
        body: { accept: true, oauth_query: consent.search.slice(1) },
      })
      expect(accepted.status, await accepted.clone().text()).toBe(200)
      const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get('code')!
      const tok = await call('/auth/oauth2/token', {
        form: true,
        body: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: id,
          resource: MCP,
        },
      })
      expect(tok.status, await tok.clone().text()).toBe(200)
      const granted = set(decode(((await tok.json()) as { access_token: string }).access_token).scope)
      expect(granted).toEqual([...DEFAULTS].sort())
      expect(granted).not.toContain('audit:read')
    })
})

describe('group 2: a named scope passes through untouched', () => {
  it('a named set is asked for and granted exactly', async () => {
    const id = await registerNoScope()
    const named = 'openid audit:read contacts:write'
    const { asked, granted } = await toToken(id, named, 'signed-in', 'g2-named@x.test')
    expect(asked).toEqual(set(named))
    expect(granted).toEqual(set(named))
  })

  it('a named scope outside the provider list is still the invalid_scope redirect', async () => {
    const id = await registerNoScope()
    const loc = await authorizeRedirect(
      authorizeUrl(id, 'openid nonsense:write'),
      (await signUp('g2-bad@x.test')).cookie,
    )
    expect(loc.origin + loc.pathname).toBe(REDIRECT)
    expect(loc.searchParams.get('error')).toBe('invalid_scope')
  })

  it('a tampered query over a filled scope is still invalid_signature', async () => {
    const id = await registerNoScope()
    const { cookie } = await signUp('g2-tamper@x.test')
    const loc = await authorizeRedirect(authorizeUrl(id), cookie)
    const res = await call('/auth/oauth2/consent', {
      cookie,
      body: { accept: true, oauth_query: loc.search.slice(1).replace('openid', 'openid%20audit%3Aread') },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await res.json()) as any).error).toBe('invalid_signature')
  })
})

// [[UI449]] D9's premise (cycle 1 group 5): Better Auth's consent `scope` field, sent as the grouped consent page will send it
// (`POST /auth/oauth2/consent { accept: true, oauth_query, scope }`), narrows the grant, refuses an unrequested scope, and leaves a narrowed grant
// to be asked again. The library code cannot be mutated: the control (no `scope`) is what shows each assertion discriminates.
describe('group 3 (UI449): the consent scope field narrows, refuses and re-prompts', () => {
  const SUBSET = ['contacts:read', 'contacts:request_approval', 'offline_access', 'openid']

  async function consentTo(clientId: string, cookie: string, scope: string | undefined) {
    const consent = await authorizeRedirect(authorizeUrl(clientId), cookie)
    expect(consent.pathname).toBe('/consent')
    return call('/auth/oauth2/consent', {
      cookie,
      body: { accept: true, oauth_query: consent.search.slice(1), ...(scope === undefined ? {} : { scope }) },
    })
  }
  async function tokenScope(clientId: string, accepted: Response): Promise<string[]> {
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get('code')!
    const tok = await call('/auth/oauth2/token', {
      form: true,
      body: {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
        resource: MCP,
      },
    })
    expect(tok.status, await tok.clone().text()).toBe(200)
    return set(decode(((await tok.json()) as { access_token: string }).access_token).scope)
  }
  /** Where a second authorize lands: the consent page, or the callback with a code (consent skipped). */
  async function secondAuthorize(clientId: string, cookie: string): Promise<'consent' | 'callback'> {
    const loc = await authorizeRedirect(authorizeUrl(clientId), cookie)
    if (loc.pathname === '/consent') return 'consent'
    expect(loc.origin + loc.pathname).toBe(REDIRECT)
    expect(loc.searchParams.get('code')).toBeTruthy()
    return 'callback'
  }

  it('a strict subset of the requested scopes is what the token holds, and the subset is strict', async () => {
    expect(DEFAULTS.length).toBeGreaterThan(SUBSET.length)
    const id = await registerNoScope()
    const { cookie } = await signUp('g3-narrow@x.test')
    const granted = await tokenScope(id, await consentTo(id, cookie, SUBSET.join(' ')))
    expect(granted).toEqual(SUBSET)
  })

  it('a scope the query did not request is refused with 400 invalid_request', async () => {
    expect(DEFAULTS).not.toContain('audit:read')
    const id = await registerNoScope()
    const { cookie } = await signUp('g3-refuse@x.test')
    const res = await consentTo(id, cookie, `${SUBSET.join(' ')} audit:read`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_request')
  })

  it('a narrowed consent is asked again on the next authorize', async () => {
    const id = await registerNoScope()
    const { cookie } = await signUp('g3-reprompt@x.test')
    await tokenScope(id, await consentTo(id, cookie, SUBSET.join(' ')))
    expect(await secondAuthorize(id, cookie)).toBe('consent')
  })

  it('control: a consent without scope grants the full requested set and the next authorize skips consent', async () => {
    const id = await registerNoScope()
    const { cookie } = await signUp('g3-control@x.test')
    const granted = await tokenScope(id, await consentTo(id, cookie, undefined))
    expect(granted).toEqual([...DEFAULTS].sort())
    expect(await secondAuthorize(id, cookie)).toBe('callback')
  })
})
