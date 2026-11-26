import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { registrationScopes, seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry, defaultGrantScopes, grantableScopes } from '@vibase/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[CORE630]] group 4 (D2) in workerd, through the real library: `limited_login` is a provider scope. One round trip per accepted class: the device grant of the seeded `vibase-cli` client and an
// authorization-code grant on another client, each with the marker; the token carries it and a refresh keeps it. It is in no vault list and in no default list.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableScopes(declared)
const DEFAULTS = registrationScopes(declared, grantable, defaultGrantScopes(declared)).defaults
const LIMITED = 'limited_login'
const MCP = `${BASE}/mcp`
const REDIRECT = 'http://127.0.0.1:33418/cb'
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
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
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

const call = (path: string, init: { body?: unknown; form?: boolean; cookie?: string; method?: string } = {}) =>
  w.call(path, { ...init, headers: ip() })
const signUp = (email: string) => authKitOver(call as never, BASE, declared).signUp(email)

async function refreshed(clientId: string, refreshToken: string, resource = MCP): Promise<string[]> {
  const res = await call('/auth/oauth2/token', {
    form: true,
    body: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource },
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return set(decode(((await res.json()) as { access_token: string }).access_token).scope)
}

const registerNoScope = async () => {
  const reg = await call('/auth/oauth2/register', {
    body: {
      client_name: 'Claude Web',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [REDIRECT],
    },
  })
  expect(reg.status, await reg.clone().text()).toBe(201)
  return ((await reg.json()) as { client_id: string }).client_id
}

describe('group 4: the marker is a provider scope', () => {
  it('device grant (vibase-cli): a request naming the marker is approved, the token carries it, and a refresh keeps it', async () => {
    const { cookie } = await signUp('limited-device@x.test')
    const issued = await call('/auth/device/code', {
      body: { client_id: 'vibase-cli', scope: `contacts:read ${LIMITED} offline_access`, resource: BASE },
    })
    const codes = (await issued.json()) as { device_code: string; user_code: string }
    expect(codes.device_code, `the device request was refused: ${JSON.stringify(codes)}`).toBeTruthy()
    await call(`/auth/device?user_code=${codes.user_code}`, { cookie })
    expect((await call('/auth/device/approve', { cookie, body: { userCode: codes.user_code } })).status).toBe(200)
    const tok = await call('/auth/oauth2/token', {
      form: true,
      body: { grant_type: DEVICE, device_code: codes.device_code, client_id: 'vibase-cli', resource: BASE },
    })
    expect(tok.status, await tok.clone().text()).toBe(200)
    const body = (await tok.json()) as { access_token: string; refresh_token: string }
    expect(set(decode(body.access_token).scope)).toEqual(['contacts:read', LIMITED, 'offline_access'].sort())
    expect(await refreshed('vibase-cli', body.refresh_token, BASE)).toEqual(
      ['contacts:read', LIMITED, 'offline_access'].sort(),
    )
  })

  it('authorize and consent on another client (dynamic registration, no scope named): the marker is granted and kept by a refresh', async () => {
    const clientId = await registerNoScope()
    const { cookie } = await signUp('limited-authorize@x.test')
    const scope = `openid contacts:read ${LIMITED} offline_access`
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      state: 'st',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: MCP,
    })
    const res = (await w.mf.dispatchFetch(`${BASE}/auth/oauth2/authorize?${q}`, {
      redirect: 'manual',
      headers: { origin: BASE, ...ip(), cookie },
    })) as unknown as Response
    const raw = res.status === 302 ? res.headers.get('location') : ((await res.json()) as { url?: string }).url
    expect(raw, `authorize answered ${res.status}`).toBeTruthy()
    const consent = new URL(raw!, BASE)
    expect(consent.pathname).toBe('/app/consent')
    expect(set(consent.searchParams.get('scope'))).toContain(LIMITED)
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
        client_id: clientId,
        resource: MCP,
      },
    })
    expect(tok.status, await tok.clone().text()).toBe(200)
    const body = (await tok.json()) as { access_token: string; refresh_token: string }
    expect(set(decode(body.access_token).scope)).toEqual(set(scope))
    expect(await refreshed(clientId, body.refresh_token)).toEqual(set(scope))
  })

  it('the marker is in no vault list and in no default list', () => {
    expect(declared).not.toContain(LIMITED)
    expect(grantable).not.toContain(LIMITED)
    expect(DEFAULTS).not.toContain(LIMITED)
    expect(registrationScopes(declared, grantable).defaults).not.toContain(LIMITED)
  })

  it('a scope-less authorize on a registered client (the CORE330 fill) and the discovery document: the fill never carries the marker, scopes_supported lists it', async () => {
    const meta = (await (await call('/.well-known/oauth-authorization-server/auth')).json()) as {
      scopes_supported: string[]
    }
    expect(meta.scopes_supported).toContain(LIMITED)
    const { cookie } = await signUp('limited-fill@x.test')
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: await registerNoScope(),
      redirect_uri: REDIRECT,
      state: 'st',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: MCP,
    })
    const res = (await w.mf.dispatchFetch(`${BASE}/auth/oauth2/authorize?${q}`, {
      redirect: 'manual',
      headers: { origin: BASE, ...ip(), cookie },
    })) as unknown as Response
    const raw = res.status === 302 ? res.headers.get('location') : ((await res.json()) as { url?: string }).url
    const asked = set(new URL(raw!, BASE).searchParams.get('scope'))
    expect(asked).toEqual([...DEFAULTS].sort())
    expect(asked).not.toContain(LIMITED)
  })
})
