import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BASE, PAIRED_ORG, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { authOptions, resourcesFor, seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import {
  createOAuthClient,
  deleteOAuthClient,
  getOAuthClient,
  openControlDb,
  readOAuthClientName,
  updateOAuthClient,
} from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { betterAuth } from 'better-auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[CORE623]] cycle 1, charter groups 1, 5 and the refresh half of 6: a client the control store wrote is served by Better Auth's REAL authorize, token and refresh in workerd (the real Worker module,
// the paired databases, a signed-in owner), and deleting it is the revocation. The store is called from the test process on the harness's control database, as the operations will be in cycle 2.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const MCP = `${BASE}/mcp`
const REDIRECT = 'https://app.test/cb'
const SCOPES = ['openid', 'offline_access', 'contacts:read']
const ACTOR = '0190b2c4-0000-7000-8000-0000000000a1'
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
let n = 0
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 250) + 1}` })
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>
const verifier = 'v'.repeat(60)
const challenge = createHash('sha256').update(verifier).digest('base64url')
let seq = 0
const clientId = () => `${(seq++).toString().padStart(2, '0')}${'c'.repeat(30)}`.slice(0, 32)

let bundle: Bundle
let w: Workerd
let cookie: string
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({
    bundle,
    bindings: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1' },
    paired: true,
  })
  await seedFirstPartyClient(w.control as never, { baseURL: BASE })
  const kit = authKitOver(((p: string, i: object) => w.call(p, { ...i, headers: ip() })) as never, BASE, declared)
  const { userId, cookie: c } = await kit.signUp('owner@x.test')
  cookie = c
  const human = uuidv7()
  await seedPrincipal(w.d1, {
    id: human,
    kind: 'user',
    email: 'owner@x.test',
    authProvider: 'better-auth',
    authSubject: userId,
  })
  await seedMembership(w.d1, { organizationId: PAIRED_ORG, userId: human, role: 'owner' })
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

const control = () => openControlDb(w.control)
const create = (over: Partial<Parameters<typeof createOAuthClient>[1]> = {}) =>
  createOAuthClient(control(), {
    organizationId: PAIRED_ORG,
    clientId: clientId(),
    name: 'Acme App',
    redirectUris: [REDIRECT],
    scopes: SCOPES,
    skipConsent: true,
    resources: resourcesFor(BASE),
    actorId: ACTOR,
    now: NOW,
    newId: uuidv7,
    ...over,
  }) as Promise<{ clientId: string }>

const call = (path: string, init: { body?: unknown; form?: boolean; cookie?: string } = {}) =>
  w.call(path, { ...init, headers: ip() })
const authorizePath = (id: string, resource: string) =>
  `/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, scope: 'openid offline_access contacts:read', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource })}`
const authorize = async (id: string, resource: string) => {
  const res = (await w.mf.dispatchFetch(BASE + authorizePath(id, resource), {
    redirect: 'manual',
    headers: { origin: BASE, ...ip(), cookie },
  })) as unknown as Response
  const text = await res.text()
  let raw = res.status === 302 ? res.headers.get('location') : null
  if (!raw) {
    try {
      raw = (JSON.parse(text) as { url?: string }).url ?? null
    } catch {
      /* an error body */
    }
  }
  return { status: res.status, text, url: raw ? new URL(raw, BASE) : null }
}
const exchange = async (id: string, code: string, resource: string) => {
  const res = await call('/auth/oauth2/token', {
    form: true,
    body: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: id,
      resource,
    },
  })
  return { status: res.status, ...((await res.json()) as Record<string, any>) } as Record<string, any>
}
const refresh = async (id: string, token: string, resource: string) => {
  const res = await call('/auth/oauth2/token', {
    form: true,
    body: { grant_type: 'refresh_token', refresh_token: token, client_id: id, resource },
  })
  return { status: res.status, ...((await res.json()) as Record<string, any>) } as Record<string, any>
}
/** The whole flow for a client that skips consent: authorize straight to the redirect URI with a code, then the PKCE exchange. */
async function tokensFor(id: string, resource: string) {
  const a = await authorize(id, resource)
  expect(a.url, `authorize answered ${a.status} ${a.text}`).not.toBeNull()
  expect(a.url!.origin + a.url!.pathname).toBe(REDIRECT)
  const code = a.url!.searchParams.get('code')
  expect(code, a.text).toBeTruthy()
  return exchange(id, code!, resource)
}
const api = async (t: string) =>
  (await w.call('/api/v1/contacts', { headers: { authorization: `Bearer ${t}` } })).status
const mcp = async (t: string) =>
  (
    await w.mf.dispatchFetch(MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  ).status
const count = async (table: string, id: string) =>
  Number((await w.controlRows<{ n: number }>(`select count(*) as n from ${table} where client_id = ?`, id))[0]!.n)

describe('group 1: the round trip through the real library', () => {
  it('skip_consent true: authorize goes straight to the redirect URI with a code; PKCE exchange, refresh, and the token works on the API origin and on /mcp', async () => {
    const { clientId: id } = await create()
    const forApi = await tokensFor(id, BASE)
    expect(forApi.status, JSON.stringify(forApi)).toBe(200)
    expect([decode(forApi.access_token).aud].flat()).toContain(BASE)
    expect(decode(forApi.access_token).scope).toContain('contacts:read')
    expect(await api(forApi.access_token)).toBe(200)
    const forMcp = await tokensFor(id, MCP)
    expect(forMcp.status, JSON.stringify(forMcp)).toBe(200)
    expect(await mcp(forMcp.access_token)).toBe(200)
    // offline_access: a refresh token, and the refresh exchange works
    expect(forApi.refresh_token, JSON.stringify(forApi)).toBeTruthy()
    const again = await refresh(id, forApi.refresh_token, BASE)
    expect(again.status, JSON.stringify(again)).toBe(200)
    expect(await api(again.access_token)).toBe(200)
    expect(await readOAuthClientName(control(), id)).toBe('Acme App')
  })

  it('skip_consent false: authorize sends a signed-in person to /app/consent', async () => {
    const { clientId: id } = await create({ skipConsent: false })
    const a = await authorize(id, BASE)
    expect(a.url, a.text).not.toBeNull()
    expect(a.url!.pathname).toBe('/app/consent')
    expect(a.url!.searchParams.get('code')).toBeNull()
  })

  it('every D4 column of a store-written row equals the same column of a row the library own adapter wrote with the same values', async () => {
    const { clientId: storeId } = await create({ skipConsent: true })
    const auth = betterAuth(
      authOptions(w.control as never, { secret: 'parity-only-secret-never-signs-0123456789-abcdef', baseURL: BASE }),
    )
    const { adapter } = (await auth.$context) as unknown as {
      adapter: { create(o: { model: string; data: Record<string, unknown> }): Promise<unknown> }
    }
    const libId = clientId()
    const at = new Date(NOW)
    await adapter.create({
      model: 'oauthClient',
      data: {
        clientId: libId,
        name: 'Acme App',
        redirectUris: [REDIRECT],
        scopes: SCOPES,
        skipConsent: true,
        requirePKCE: true,
        disabled: false,
        tokenEndpointAuthMethod: 'none',
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        applicationType: 'web',
        referenceId: PAIRED_ORG,
        createdAt: at,
        updatedAt: at,
      },
    })
    const row = async (id: string) =>
      (await w.controlRows<Record<string, unknown>>('select * from auth_oauth_clients where client_id = ?', id))[0]!
    const { id: _a, client_id: _b, ...store } = await row(storeId)
    const { id: _c, client_id: _d, ...lib } = await row(libId)
    expect(store).toEqual(lib)
  })
})

describe('group 5: delete is the revocation (D9)', () => {
  it('after delete the refresh token is refused, authorize refuses the client id, every dependent row is gone, and another client refresh still works', async () => {
    const { clientId: gone } = await create({ skipConsent: false })
    const { clientId: kept } = await create()
    // the consent-required client's whole flow, through the page's exact consent call
    const a = await authorize(gone, BASE)
    const accepted = await call('/auth/oauth2/consent', {
      cookie,
      body: { accept: true, oauth_query: a.url!.search.slice(1) },
    })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get('code')!
    const first = await exchange(gone, code, BASE)
    expect(first.status, JSON.stringify(first)).toBe(200)
    expect(first.refresh_token).toBeTruthy()
    const second = await tokensFor(kept, BASE)
    // (a token granted for a resource is a JWT: no access-token row exists, so only the other three are present to be cascaded)
    for (const table of ['auth_oauth_refresh_tokens', 'auth_oauth_consents', 'auth_oauth_client_resources'])
      expect(await count(table, gone), table).toBeGreaterThan(0)

    expect(
      await deleteOAuthClient(control(), {
        organizationId: PAIRED_ORG,
        clientId: gone,
        actorId: ACTOR,
        now: NOW,
        newId: uuidv7,
      }),
    ).toBe(true)

    const refused = await refresh(gone, first.refresh_token, BASE)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.access_token).toBeUndefined()
    const after = await authorize(gone, BASE)
    expect(after.url?.searchParams.get('code') ?? null).toBeNull()
    expect(after.url?.pathname).toBe('/auth/error')
    expect(after.url?.searchParams.get('error')).toBe('invalid_client')
    for (const table of [
      'auth_oauth_clients',
      'auth_oauth_access_tokens',
      'auth_oauth_refresh_tokens',
      'auth_oauth_consents',
      'auth_oauth_client_resources',
    ])
      expect(await count(table, gone), table).toBe(0)
    const ok = await refresh(kept, second.refresh_token, BASE)
    expect(ok.status, JSON.stringify(ok)).toBe(200)
  })
})

describe('group 6 (refresh half): update keeps the client servable', () => {
  it('a refresh for an edited client still succeeds, and a new authorize honours the edited redirect list and skip_consent', async () => {
    const { clientId: id } = await create()
    const first = await tokensFor(id, BASE)
    const rec = await updateOAuthClient(control(), {
      organizationId: PAIRED_ORG,
      clientId: id,
      actorId: ACTOR,
      now: NOW,
      newId: uuidv7,
      name: 'Renamed',
      skipConsent: false,
    })
    expect(rec).toMatchObject({ name: 'Renamed', skipConsent: false, redirectUris: [REDIRECT], scopes: SCOPES })
    expect(await getOAuthClient(control(), { organizationId: PAIRED_ORG, clientId: id })).toMatchObject({
      name: 'Renamed',
    })
    const again = await refresh(id, first.refresh_token, BASE)
    expect(again.status, JSON.stringify(again)).toBe(200)
    const a = await authorize(id, BASE)
    expect(a.url!.pathname).toBe('/app/consent')
  })
})
