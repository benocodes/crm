import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry } from '@vibase/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[UI247]] D8 / charter group 5: the real flows in workerd with the pages' EXACT calls (the real Worker module, test admission, disposable D1s, no network): the device grant through /device's
// calls, an authorization code request through /consent's call, and the sign-in continuation.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
const MCP = `${BASE}/mcp`
const REDIRECT = 'http://127.0.0.1:33418/cb'
const PASSWORD = 'a long enough password 123'
let n = 0
/** Each call from its own client IP: the device lookup is limited to 5 per IP per 30 minutes (D2), and sign-in and registration are limited too. */
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 250) + 1}` })
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>

let bundle: Bundle
let w: Workerd
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({ bundle, bindings: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1' }, paired: true })
  await seedFirstPartyClient(w.control as never, { baseURL: BASE })
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

const call = (path: string, init: { body?: unknown; form?: boolean; cookie?: string; method?: string } = {}) => w.call(path, { ...init, headers: ip() })
const signUp = (email: string) => authKitOver(call as never, BASE, declared).signUp(email)
/**
 * Where an authorize request sends the browser. Better Auth answers a navigation with a `302` and a `fetch` with `{ redirect: true, url }` (the library decides from the request's headers, which
 * workerd's dispatch does not set the way a browser does); both carry the same URL, so a test reads either.
 */
async function authorizeRedirect(path: string, cookie?: string): Promise<URL> {
  const res = (await w.mf.dispatchFetch(BASE + path, { redirect: 'manual', headers: { origin: BASE, ...ip(), ...(cookie ? { cookie } : {}) } })) as unknown as Response
  const raw = res.status === 302 ? res.headers.get('location') : ((await res.json()) as { redirect?: boolean; url?: string }).url
  expect(raw, `authorize answered ${res.status}`).toBeTruthy()
  return new URL(raw!, BASE)
}

describe('device: the /device page\'s calls', () => {
  it('a code issued for vibase-cli names the page, is claimed unseparated by a signed-in person, approved, and redeemed', async () => {
    const { cookie } = await signUp('device@x.test')
    const issued = await call('/auth/device/code', { body: { client_id: 'vibase-cli', scope: 'openid contacts:read', resource: BASE } })
    expect(issued.status, await issued.clone().text()).toBe(200)
    const codes = (await issued.json()) as Record<string, any>
    expect(codes.user_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    expect(codes.verification_uri).toBe(`${BASE}/device`)
    expect(codes.verification_uri_complete).toBe(`${BASE}/device?user_code=${codes.user_code}`)

    // the page's calls: public-client for the name, the claim (unseparated), approve with { userCode }
    const name = await call('/auth/oauth2/public-client?client_id=vibase-cli', { cookie })
    expect(((await name.json()) as any).client_name).toBe('Vibase CLI')
    const claim = await call(`/auth/device?user_code=${codes.user_code}`, { cookie })
    expect(claim.status).toBe(200)
    expect(await claim.json()).toMatchObject({ status: 'pending', client_id: 'vibase-cli', scope: 'openid contacts:read' })
    expect((await call('/auth/device/approve', { cookie, body: { userCode: codes.user_code } })).status).toBe(200)

    const tok = await call('/auth/oauth2/token', { form: true, body: { grant_type: DEVICE, device_code: codes.device_code, client_id: 'vibase-cli', resource: BASE } })
    expect(tok.status, await tok.clone().text()).toBe(200)
    expect(decode(((await tok.json()) as any).access_token).scope).toContain('contacts:read')
  })

  it('a person who did not claim the code gets no client_id, and cannot approve it', async () => {
    const a = await signUp('claimer@x.test')
    const b = await signUp('other@x.test')
    const codes = (await (await call('/auth/device/code', { body: { client_id: 'vibase-cli', scope: 'openid', resource: BASE } })).json()) as { user_code: string }
    expect((await call(`/auth/device?user_code=${codes.user_code}`, { cookie: a.cookie })).status).toBe(200)
    const other = (await (await call(`/auth/device?user_code=${codes.user_code}`, { cookie: b.cookie })).json()) as Record<string, unknown>
    expect(other.client_id).toBeUndefined()
    expect((await call('/auth/device/approve', { cookie: b.cookie, body: { userCode: codes.user_code } })).status).toBeGreaterThanOrEqual(400)
  })

  it('a deny is answered 200 and the grant is then refused to the CLI', async () => {
    const { cookie } = await signUp('denier@x.test')
    const codes = (await (await call('/auth/device/code', { body: { client_id: 'vibase-cli', scope: 'openid', resource: BASE } })).json()) as { user_code: string; device_code: string }
    await call(`/auth/device?user_code=${codes.user_code}`, { cookie })
    expect((await call('/auth/device/deny', { cookie, body: { userCode: codes.user_code } })).status).toBe(200)
    const tok = await call('/auth/oauth2/token', { form: true, body: { grant_type: DEVICE, device_code: codes.device_code, client_id: 'vibase-cli', resource: BASE } })
    expect(((await tok.json()) as any).error).toBe('access_denied')
  })
})

describe('authorization code: /sign-in then /consent', () => {
  const verifier = 'v'.repeat(60)
  const register = async () => {
    const res = await call('/auth/oauth2/register', {
      body: { client_name: 'Claude Desktop', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], redirect_uris: [REDIRECT], scope: 'openid offline_access contacts:read' },
    })
    expect(res.status, await res.clone().text()).toBe(201)
    return ((await res.json()) as { client_id: string }).client_id
  }
  const authorize = (clientId: string) =>
    `/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid contacts:read', state: 'st 1&x', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: MCP }).toString()}`

  it('a signed-in person is sent to /consent; the page\'s exact consent call redirects to the client with a code that exchanges for tokens', async () => {
    const id = await register()
    const { cookie } = await signUp('consent@x.test')
    const loc = await authorizeRedirect(authorize(id), cookie)
    expect(loc.pathname).toBe('/consent')
    const oauthQuery = loc.search.slice(1)

    const accepted = await call('/auth/oauth2/consent', { cookie, body: { accept: true, oauth_query: oauthQuery } })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const answer = (await accepted.json()) as { redirect: boolean; url: string }
    expect(answer.redirect).toBe(true)
    const back = new URL(answer.url)
    expect(back.origin + back.pathname).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('st 1&x')
    const code = back.searchParams.get('code')!
    expect(code).toBeTruthy()

    const tok = await call('/auth/oauth2/token', { form: true, body: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: id, resource: MCP } })
    expect(tok.status, await tok.clone().text()).toBe(200)
    const body = (await tok.json()) as { access_token: string }
    expect(decode(body.access_token).scope).toContain('contacts:read')
  })

  it('Deny redirects to the client with error=access_denied and the same state', async () => {
    const id = await register()
    const { cookie } = await signUp('deny@x.test')
    const oauthQuery = (await authorizeRedirect(authorize(id), cookie)).search.slice(1)
    const res = await call('/auth/oauth2/consent', { cookie, body: { accept: false, oauth_query: oauthQuery } })
    const back = new URL(((await res.json()) as { url: string }).url)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe('st 1&x')
  })

  it('a tampered query is refused with invalid_signature', async () => {
    const id = await register()
    const { cookie } = await signUp('tamper@x.test')
    const oauthQuery = (await authorizeRedirect(authorize(id), cookie)).search.slice(1)
    const res = await call('/auth/oauth2/consent', { cookie, body: { accept: true, oauth_query: oauthQuery.replace('contacts%3Aread', 'agents%3Awrite') } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await res.json()) as any).error).toBe('invalid_signature')
  })

  it('signed out: authorize lands on /sign-in with the signed query, and the sign-in call with oauth_query answers the /consent redirect', async () => {
    const id = await register()
    await signUp('resume@x.test')
    const loc = await authorizeRedirect(authorize(id))
    expect(loc.pathname).toBe('/sign-in')
    expect(loc.searchParams.get('sig')).toBeTruthy()
    const oauthQuery = loc.search.slice(1)

    const signedIn = await call('/auth/sign-in/email', { body: { email: 'resume@x.test', password: PASSWORD, oauth_query: oauthQuery } })
    expect(signedIn.status, await signedIn.clone().text()).toBe(200)
    const answer = (await signedIn.json()) as { redirect?: boolean; url?: string }
    expect(answer.redirect).toBe(true)
    expect(new URL(answer.url!, BASE).pathname).toBe('/consent')
  })
})
