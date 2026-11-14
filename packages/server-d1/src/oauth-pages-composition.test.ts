import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '@vibase/api'
import { AUTH_BASE, authKit, type AuthKit } from './test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[UI247]] D1, D2: the composed Better Auth names the vault's own pages (`/consent`, `<base>/device`) and pins the device code's format, on the real handler and a real control-plane database.
let w: WorkerPair
let kit: AuthKit
const declared = createVibaseRegistry().declaredScopes()
beforeAll(async () => {
  w = await openWorkerPair()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  kit = authKit(w.control, { scopes: declared })
})

const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
const register = async (name = 'Claude Desktop') => {
  const res = await kit.call('/auth/oauth2/register', {
    body: { client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], redirect_uris: ['http://127.0.0.1:33418/cb'], scope: 'openid contacts:read' },
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}
const authorizeUrl = (clientId: string) => {
  const challenge = createHash('sha256').update('v'.repeat(50)).digest('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33418/cb', scope: 'openid contacts:read', state: 'st 1&x', code_challenge: challenge, code_challenge_method: 'S256', resource: `${AUTH_BASE}/mcp` })
  return `/auth/oauth2/authorize?${q.toString()}`
}

describe('the device grant (D1, D2)', () => {
  it('verification_uri and verification_uri_complete name the page at <base>/device, not /auth/device', async () => {
    const dev = await kit.call('/auth/oauth2/register', {
      body: { client_name: 'Dev', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], response_types: ['code'], redirect_uris: ['http://127.0.0.1:33418/cb'], scope: 'openid contacts:read' },
    })
    const clientId = ((await dev.json()) as { client_id: string }).client_id
    const res = await kit.call('/auth/device/code', { body: { client_id: clientId, scope: 'openid contacts:read', resource: AUTH_BASE } })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.verification_uri).toBe(`${AUTH_BASE}/device`)
    expect(body.verification_uri_complete).toBe(`${AUTH_BASE}/device?user_code=${body.user_code}`)
  })

  it('D2 pins the code: 8 characters from the 32-character alphabet, unseparated, 30 minutes, 5 seconds', async () => {
    const dev = await kit.call('/auth/oauth2/register', {
      body: { client_name: 'Dev', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], response_types: ['code'], redirect_uris: ['http://127.0.0.1:33418/cb'], scope: 'openid contacts:read' },
    })
    const clientId = ((await dev.json()) as { client_id: string }).client_id
    const codes = new Set<string>()
    for (let i = 0; i < 6; i++) {
      const res = await kit.call('/auth/device/code', { body: { client_id: clientId, scope: 'openid', resource: AUTH_BASE } })
      const body = (await res.json()) as Record<string, any>
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(body.user_code).toMatch(ALPHABET)
      expect(body.expires_in).toBe(30 * 60)
      expect(body.interval).toBe(5)
      codes.add(body.user_code)
    }
    expect(codes.size).toBe(6)
  })
})

describe('the consent page (D1)', () => {
  it('a signed-in authorize that needs consent redirects to the vault page /consent with the signed query', async () => {
    const id = await register()
    const { cookie } = await kit.signUp('person@x.test')
    const res = await kit.call(authorizeUrl(id), { cookie })
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!, AUTH_BASE)
    expect(loc.pathname).toBe('/consent')
    expect(loc.searchParams.get('client_id')).toBe(id)
    expect(loc.searchParams.get('sig')).toBeTruthy()
  })

  it('an unauthenticated authorize goes to /sign-in with the same signed query', async () => {
    const id = await register()
    const res = await kit.call(authorizeUrl(id))
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!, AUTH_BASE)
    expect(loc.pathname).toBe('/sign-in')
    expect(loc.searchParams.get('sig')).toBeTruthy()
  })
})
