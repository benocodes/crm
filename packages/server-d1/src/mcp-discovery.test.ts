import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractWWWAuthenticateParams, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js'
import { uuidv7 } from '@vibase/storage'
import { MIGRATIONS } from '@vibase/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { createVaultRegistry, grantableScopes, toProviderScope } from '@vibase/api'
import { mintClerkToken } from '@vibase/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, clerkKit, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[API115]] (API106 cycle 2): MCP OAuth discovery through the real D1 composition: the path-specific protected-resource document (D13),
// the `/mcp` challenge (D14), the preflight on the discovery documents (D16) and the `mcp` field of `/.well-known/vibase` (D17).

let w: WorkerD1
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  kit.fetch.reset()
  kit.profiles.clear()
  vi.restoreAllMocks()
})

const BASE = 'https://w.test'
const VIBASE = '/.well-known/vibase'
const PRM = '/.well-known/oauth-protected-resource'
const PRM_MCP = `${PRM}/mcp`
const NAMES = MIGRATIONS.map((m) => m.name)
const declared = createVaultRegistry().declaredScopes()
const grantable = grantableScopes(declared).map(toProviderScope)
const rootChallenge = (origin: string) => `Bearer resource_metadata="${origin}${PRM}"`
const mcpChallenge = (origin: string) => `Bearer resource_metadata="${origin}${PRM_MCP}", scope="${grantable.join(' ')}"`

const worker = (extra: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: 'cli_client_test', ...extra }, { fetch: kit.fetch })
type Wk = ReturnType<typeof worker>
const call = (wk: Wk, path: string, init: RequestInit & { base?: string } = {}) => wk.fetch(new Request((init.base ?? BASE) + path, init))
const boot = () => bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: kit.issuer.issuer }, { now: NOW, newId: () => uuidv7(NOW) })
const tracker = async (names: readonly string[]) => {
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, names)
}
const ping = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }

describe('D13 GET /.well-known/oauth-protected-resource/mcp', () => {
  it('resource is <origin>/mcp, scopes_supported is exactly the agent-grantable set in provider names, no human-only scope', async () => {
    const res = await call(worker(), PRM_MCP)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: `${BASE}/mcp`,
      authorization_servers: [kit.issuer.issuer],
      scopes_supported: grantable,
      bearer_methods_supported: ['header'],
      resource_name: 'Vibase',
    })
    const body = (await (await call(worker(), PRM_MCP, { base: 'http://localhost:8787' })).json()) as any
    expect(body.resource).toBe('http://localhost:8787/mcp')
    const humanOnly = declared.filter((s) => !grantableScopes(declared).includes(s))
    expect(humanOnly.length).toBeGreaterThan(0)
    for (const s of humanOnly) expect(body.scopes_supported).not.toContain(toProviderScope(s))
    expect(new Set(body.scopes_supported)).toEqual(new Set(grantableScopes(declared).map(toProviderScope)))
  })

  it('the root document is unchanged: every declared scope, resource is the origin', async () => {
    const body = (await (await call(worker(), PRM)).json()) as any
    expect(body).toEqual({ resource: BASE, authorization_servers: [kit.issuer.issuer], scopes_supported: declared.map(toProviderScope), bearer_methods_supported: ['header'] })
  })

  it('public with headers: Cache-Control and a wildcard origin, no challenge; HEAD answers the same headers with no body', async () => {
    const wk = worker({ CORS_ALLOWED_ORIGINS: 'https://app.example' })
    for (const headers of [{}, { authorization: 'Bearer garbage' }] as Record<string, string>[]) {
      const res = await call(wk, PRM_MCP, { headers: { ...headers, origin: 'https://mcp.client.example' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
      expect(res.headers.get('www-authenticate')).toBeNull()
    }
    const head = await call(wk, PRM_MCP, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toMatch(/^application\/json/)
    expect(head.headers.get('cache-control')).toBe('public, max-age=60')
    expect(await head.text()).toBe('')
  })

  it('exact path: a trailing slash, a sub-path and a longer name are not this document (no marker: 503 not_initialised)', async () => {
    const wk = worker()
    for (const path of [`${PRM_MCP}/`, `${PRM_MCP}/x`, `${PRM_MCP}x`, `${PRM}/other`]) {
      const res = await call(wk, path)
      expect(res.status, path).toBe(503)
      expect(((await res.json()) as any).error.code).toBe('not_initialised')
    }
  })

  it('without a provider it is 404 not_found', async () => {
    const res = await call(worker({ AUTH_PROVIDER: undefined }), PRM_MCP)
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('not_found')
  })

  it('answers with no deployment marker and while migrations are pending, where an API route is 503', async () => {
    await tracker(NAMES)
    expect((await call(worker(), PRM_MCP)).status).toBe(200)
    await boot()
    await w.d1.prepare('delete from d1_migrations where name = ?').bind(NAMES.at(-1)).run()
    const wk = worker()
    expect((await call(wk, PRM_MCP)).status).toBe(200)
    const api = await call(wk, '/api/v1/contacts')
    expect(((await api.json()) as any).error.code).toBe('migrations_pending')
  })

  it.each([
    ['missing CLERK_JWT_KEY', { CLERK_JWT_KEY: undefined }],
    ['unknown AUTH_PROVIDER', { AUTH_PROVIDER: 'nope' }],
  ])('%s: 500 internal', async (_n, extra) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call(worker(extra as Partial<D1WorkerEnv>), PRM_MCP)
    expect(res.status).toBe(500)
    expect(((await res.json()) as any).error.code).toBe('internal')
  })
})

describe('D14 the 401 challenge on /mcp', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('/mcp without a credential, with a bad token and with a revoked key carries the /mcp challenge, header compared whole', async () => {
    quiet()
    const { key } = await boot()
    await tracker(NAMES)
    const wk = worker()
    const post = (headers: Record<string, string> = {}, base?: string) => call(wk, '/mcp', { ...ping, headers: { ...ping.headers, ...headers }, base })
    const bad = await post({ authorization: 'Bearer a.b.c' })
    const garbage = await post({ authorization: 'Bearer garbage' })
    const none = await post()
    const unknownKey = await post({ authorization: 'Bearer vk_unknown_key' })
    for (const res of [none, bad, garbage, unknownKey]) {
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe(mcpChallenge(BASE))
    }
    expect((await post({ authorization: `Bearer ${key}` })).status).toBe(200)
    await w.d1.prepare('update agents set disabled_at = ?').bind(NOW.toISOString()).run()
    const revoked = await post({ authorization: `Bearer ${key}` })
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get('www-authenticate')).toBe(mcpChallenge(BASE))
    expect((await post({}, 'http://localhost:8787')).headers.get('www-authenticate')).toBe(mcpChallenge('http://localhost:8787'))
    // an expired session token too
    const old = Math.floor(NOW.getTime() / 1000) - 3600
    const expired = await mintClerkToken(kit.issuer, { sub: 'user_a', extra: { vibase_role: 'owner' }, exp: old, now: new Date(NOW.getTime() - 7200_000) })
    expect((await post({ authorization: `Bearer ${expired}` })).headers.get('www-authenticate')).toBe(mcpChallenge(BASE))
  })

  it('every other path keeps the root challenge byte for byte; a path under /mcp is not /mcp', async () => {
    quiet()
    await boot()
    await tracker(NAMES)
    const wk = worker()
    for (const path of ['/api/v1/contacts', '/meta/v1/me']) {
      const res = await call(wk, path)
      expect(res.status, path).toBe(401)
      expect(res.headers.get('www-authenticate'), path).toBe(rootChallenge(BASE))
    }
    // not routes, so not 401s: no challenge of either kind
    for (const path of ['/mcp/x', '/mcpx']) {
      const res = await call(wk, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('www-authenticate'), path).toBeNull()
    }
  })

  it('the SDK client parses resource_metadata and scope out of the header the Worker sends, and its discovery reaches the document', async () => {
    await boot()
    await tracker(NAMES)
    const wk = worker()
    const res = await call(wk, '/mcp', ping)
    expect(res.status).toBe(401)
    const parsed = extractWWWAuthenticateParams(res)
    expect(parsed.resourceMetadataUrl?.href).toBe(`${BASE}${PRM_MCP}`)
    expect(parsed.scope).toBe(grantable.join(' '))
    expect(parsed.scope?.split(' ')).toEqual(grantable)
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => wk.fetch(new Request(input, init))) as typeof fetch
    const meta = await discoverOAuthProtectedResourceMetadata(`${BASE}/mcp`, { resourceMetadataUrl: parsed.resourceMetadataUrl }, fetchFn)
    expect(meta?.resource).toBe(`${BASE}/mcp`)
    expect(meta?.scopes_supported).toEqual(grantable)
    // without the hint the SDK builds the path-aware URL itself: D13's path
    const byPath = await discoverOAuthProtectedResourceMetadata(`${BASE}/mcp`, undefined, fetchFn)
    expect(byPath?.resource).toBe(`${BASE}/mcp`)
  })

  it('no provider: /mcp 401 carries no challenge (it would name a document that 404s)', async () => {
    quiet()
    await boot()
    await tracker(NAMES)
    const res = await call(worker({ AUTH_PROVIDER: undefined }), '/mcp', ping)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})

describe('D16 OPTIONS on the discovery documents', () => {
  const PREFLIGHT = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': '*', 'access-control-max-age': '600' }
  const preflight = (wk: Wk, path: string, base?: string) =>
    call(wk, path, { method: 'OPTIONS', base, headers: { origin: 'https://mcp.client.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'mcp-protocol-version' } })

  it.each([VIBASE, PRM, PRM_MCP])('%s: 204 with the four headers, before the marker and the migration gate', async (path) => {
    const wk = worker()
    const res = await preflight(wk, path)
    expect(res.status).toBe(204)
    for (const [name, value] of Object.entries(PREFLIGHT)) expect(res.headers.get(name), name).toBe(value)
    expect(await res.text()).toBe('')
    // behind the manifest, where an API route is 503
    await boot()
    await tracker(NAMES.slice(0, -1))
    expect((await preflight(worker(), path)).status).toBe(204)
  })

  it('with no provider the two protected-resource paths are still 204 (the GET then 404s) and the vibase one too', async () => {
    const wk = worker({ AUTH_PROVIDER: undefined })
    for (const path of [VIBASE, PRM, PRM_MCP]) expect((await preflight(wk, path)).status, path).toBe(204)
    expect((await call(wk, PRM_MCP)).status).toBe(404)
  })

  it.each([VIBASE, PRM, PRM_MCP])('%s: bad configuration is still 500', async (path) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await preflight(worker({ CLERK_JWT_KEY: undefined }), path)
    expect(res.status).toBe(500)
  })

  it('an OPTIONS on an unrelated /.well-known path or on a trailing-slash variant is not answered here (no marker: 503)', async () => {
    const wk = worker()
    for (const path of ['/.well-known/x', `${PRM_MCP}/`, `${VIBASE}/`, '/api/v1/contacts']) {
      const res = await preflight(wk, path)
      expect(res.status, path).toBe(503)
      expect(res.headers.get('access-control-allow-methods')).toBeNull()
    }
  })

  it('a POST on a discovery path is not a preflight', async () => {
    expect((await call(worker(), PRM_MCP, { method: 'POST' })).status).toBe(503)
  })
})

describe('D17 mcp in /.well-known/vibase', () => {
  it('is <origin>/mcp with a provider, on the request origin', async () => {
    const wk = worker()
    expect(((await (await call(wk, VIBASE)).json()) as any).mcp).toBe(`${BASE}/mcp`)
    expect(((await (await call(wk, VIBASE, { base: 'http://localhost:8787' })).json()) as any).mcp).toBe('http://localhost:8787/mcp')
  })
  it('is present without a provider, where auth is null', async () => {
    const body = (await (await call(worker({ AUTH_PROVIDER: undefined }), VIBASE)).json()) as any
    expect(body.auth).toBeNull()
    expect(body.mcp).toBe(`${BASE}/mcp`)
  })
})
