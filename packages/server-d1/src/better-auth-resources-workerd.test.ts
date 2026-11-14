import { fileURLToPath } from 'node:url'
import { BASE, PAIRED_ORG, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { seedFirstPartyClient } from '@vibase/auth'
import { createVibaseRegistry } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver } from './test/auth-kit.js'

// [[CORE283]] P1, P2: the resource matrix with REAL Better Auth tokens in workerd. The seeded vibase-cli client, a signed-in owner, and the real Worker module (test/entry-mint.ts adds only
// the test sign-up). resource in {absent, API origin, MCP URI, unknown} x grant in {device code, refresh}.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const declared = createVibaseRegistry().declaredScopes()
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
const MCP = `${BASE}/mcp`
const UNKNOWN = 'https://evil.example/api'
const SCOPE = 'openid contacts:read offline_access'
let n = 0
/** Each request from its own client IP: the device endpoints are rate limited per IP, and the matrix is not about that. */
const ip = () => ({ 'cf-connecting-ip': `203.0.113.${(n++ % 250) + 1}` })
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>

let bundle: Bundle
let w: Workerd
let cookie: string
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({ bundle, bindings: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1' }, paired: true })
  await seedFirstPartyClient(w.control as never, { baseURL: BASE })
  const kit = authKitOver(w.call as never, BASE, declared)
  const { userId, cookie: c } = await kit.signUp('owner@x.test')
  cookie = c
  const human = uuidv7()
  await seedPrincipal(w.d1, { id: human, kind: 'user', email: 'owner@x.test', authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: PAIRED_ORG, userId: human, role: 'owner' })
}, 180_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

type Tokens = { access_token?: string; refresh_token?: string; error?: string; status: number }
const readTokens = async (res: Response): Promise<Tokens> => ({ ...((await res.json().catch(() => ({}))) as object), status: res.status })
/** The device grant for the signed-in owner; `resource` omitted when undefined. Returns the first refused step's body or the tokens. */
async function deviceGrant(resource?: string): Promise<Tokens> {
  const post = (path: string, body: unknown, form = false) => w.call(path, { body: body as never, form, cookie, headers: ip() })
  const code = await post('/auth/device/code', { client_id: 'vibase-cli', scope: SCOPE, ...(resource ? { resource } : {}) })
  const codes = (await code.json()) as { device_code?: string; user_code?: string; error?: string }
  if (!code.ok) return { ...codes, status: code.status }
  expect((await w.call(`/auth/device?user_code=${encodeURIComponent(codes.user_code!)}`, { cookie, headers: ip() })).ok).toBe(true)
  expect((await post('/auth/device/approve', { userCode: codes.user_code })).ok).toBe(true)
  return readTokens(await post('/auth/oauth2/token', { grant_type: DEVICE, device_code: codes.device_code, client_id: 'vibase-cli', ...(resource ? { resource } : {}) }, true))
}
const refresh = async (token: string, resource?: string) => readTokens(await w.call('/auth/oauth2/token', { headers: ip(), form: true, body: { grant_type: 'refresh_token', refresh_token: token, client_id: 'vibase-cli', ...(resource ? { resource } : {}) } }))
const api = async (tok: string) => (await w.call('/api/v1/contacts', { headers: { authorization: `Bearer ${tok}` } })).status
// no Origin header: the MCP endpoint refuses every browser origin that is not on its CORS list
const mcp = async (tok: string) => (await w.mf.dispatchFetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status
const isJwt = (t: string) => t.split('.').length === 3

type Grant = 'device code' | 'refresh'
const cells: Array<[string | undefined, Grant]> = [
  [undefined, 'device code'],
  [undefined, 'refresh'],
  [BASE, 'device code'],
  [BASE, 'refresh'],
  [MCP, 'device code'],
  [MCP, 'refresh'],
  [UNKNOWN, 'device code'],
  [UNKNOWN, 'refresh'],
]

describe('resource x grant matrix (P1, P2)', () => {
  it.each(cells)('resource %s, grant %s', async (resource, grant) => {
    // The refresh cell obtains its refresh token by a device grant naming the same resource (a refresh cannot widen it), except for the unknown resource, which cannot be granted first:
    // its refresh names the unknown resource against a refresh token granted for the API origin.
    const first = await deviceGrant(grant === 'refresh' && resource === UNKNOWN ? BASE : resource)
    let result: Tokens
    if (grant === 'device code') result = first
    else {
      expect(first.refresh_token, JSON.stringify(first)).toBeTruthy()
      result = await refresh(first.refresh_token!, resource)
    }
    if (resource === undefined) {
      // P2: no server-side default resource: an opaque token, which the API refuses.
      expect(result.access_token, JSON.stringify(result)).toBeTruthy()
      expect(isJwt(result.access_token!)).toBe(false)
      expect(await api(result.access_token!)).toBe(401)
      expect(await mcp(result.access_token!)).toBe(401)
    } else if (resource === UNKNOWN) {
      expect(result.error, JSON.stringify(result)).toBe('invalid_target')
      expect(result.access_token).toBeUndefined()
    } else {
      expect(result.access_token, JSON.stringify(result)).toBeTruthy()
      expect(isJwt(result.access_token!)).toBe(true)
      expect([decode(result.access_token!).aud].flat()).toContain(resource)
      // P1: either known resource resolves on every surface
      expect(await api(result.access_token!)).toBe(200)
      expect(await mcp(result.access_token!)).toBe(200)
    }
  })
})

describe('discovery in workerd through the real Worker module (D12)', () => {
  it('serves the RFC 8414 document at the path-insertion URL, and the vibase document with the resource', async () => {
    const meta = await w.call('/.well-known/oauth-authorization-server/auth')
    expect(meta.status).toBe(200)
    const doc = (await meta.json()) as Record<string, string>
    expect(doc.issuer).toBe(`${BASE}/auth`)
    expect(doc.registration_endpoint).toBe(`${BASE}/auth/oauth2/register`)
    expect(doc.device_authorization_endpoint).toBe(`${BASE}/auth/device/code`)
    const vibase = (await (await w.call('/.well-known/vibase')).json()) as { auth: Record<string, string> }
    expect(vibase.auth).toEqual({ provider: 'better-auth', issuer: `${BASE}/auth`, cli_client_id: 'vibase-cli', resource: BASE, protected_resource_metadata: `${BASE}/.well-known/oauth-protected-resource`, sign_in_methods: ['password'] })
  })
})
