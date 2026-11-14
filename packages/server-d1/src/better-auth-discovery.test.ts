import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { createVibaseRegistry, grantableScopes } from '@vibase/api'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { NOW, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE283]] D12, D23, P3: discovery on `better-auth`. Every auth URL in the documents comes from PUBLIC_BASE_URL, never the request host; `api`, `mcp` and `openapi` stay request-origin.
let w: WorkerPair
const declared = createVibaseRegistry().declaredScopes()
const OTHER = 'https://other.example.test'
beforeAll(async () => {
  w = await openWorkerPair()
}, 60_000)
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
  await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE }, { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) })
})

const worker = (over: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE, ...over })
const get = async (path: string, host = AUTH_BASE, over: Partial<D1WorkerEnv> = {}) => {
  const res = await worker(over).fetch(new Request(host + path))
  return { status: res.status, json: (await res.json()) as any, headers: res.headers }
}
const PRM = '/.well-known/oauth-protected-resource'

describe('GET /.well-known/vibase (P3)', () => {
  const auth = {
    provider: 'better-auth',
    issuer: `${AUTH_BASE}/auth`,
    cli_client_id: 'vibase-cli',
    resource: AUTH_BASE,
    protected_resource_metadata: `${AUTH_BASE}${PRM}`,
    sign_in_methods: ['password'],
  }
  it('the exact auth shape: no publishable_key, the CLI client id defaults to vibase-cli', async () => {
    const res = await get('/.well-known/vibase')
    expect(res.status).toBe(200)
    expect(res.json.auth).toEqual(auth)
    expect(res.json.api).toBe(`${AUTH_BASE}/api/v1`)
  })

  it('a request on another host: the auth URLs still name PUBLIC_BASE_URL, api, mcp and openapi follow the request origin', async () => {
    const res = await get('/.well-known/vibase', OTHER)
    expect(res.json.auth).toEqual(auth)
    expect(res.json.api).toBe(`${OTHER}/api/v1`)
    expect(res.json.mcp).toBe(`${OTHER}/mcp`)
    expect(res.json.openapi.api).toBe(`${OTHER}/api/v1/openapi.json`)
  })

  it('answers before the gates, as the Clerk document does (an uninitialised control plane is still discoverable)', async () => {
    await w.reset()
    expect((await get('/.well-known/vibase')).json.auth).toEqual(auth)
  })
})

describe('protected-resource metadata (P3, D23)', () => {
  it.each([AUTH_BASE, OTHER])('both documents name the issuer and the resource from PUBLIC_BASE_URL (request host %s)', async (host) => {
    const api = (await get(PRM, host)).json
    expect(api.authorization_servers).toEqual([`${AUTH_BASE}/auth`])
    expect(api.resource).toBe(AUTH_BASE)
    const mcp = (await get(`${PRM}/mcp`, host)).json
    expect(mcp.authorization_servers).toEqual([`${AUTH_BASE}/auth`])
    expect(mcp.resource).toBe(`${AUTH_BASE}/mcp`)
    expect(mcp.scopes_supported).toEqual(grantableScopes(declared))
  })
})

describe('RFC 8414 metadata at the path-insertion URL (D12)', () => {
  const PATH = '/.well-known/oauth-authorization-server/auth'
  it.each([AUTH_BASE, OTHER])('names the issuer <PUBLIC_BASE_URL>/auth and its endpoints under it, whatever the request host (%s)', async (host) => {
    const res = await get(PATH, host)
    expect(res.status).toBe(200)
    expect(res.json.issuer).toBe(`${AUTH_BASE}/auth`)
    expect(res.json.registration_endpoint).toBe(`${AUTH_BASE}/auth/oauth2/register`)
    expect(res.json.device_authorization_endpoint).toBe(`${AUTH_BASE}/auth/device/code`)
    expect(res.json.token_endpoint).toBe(`${AUTH_BASE}/auth/oauth2/token`)
  })

  it('is no route on the Clerk provider (the Worker answers it only for better-auth)', async () => {
    const res = await composeD1Worker({ DB: w.d1 }).fetch(new Request(AUTH_BASE + PATH))
    expect(res.status).not.toBe(200)
  })
})
