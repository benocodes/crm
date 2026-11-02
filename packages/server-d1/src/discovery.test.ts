import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { MIGRATIONS } from '@vault/storage-d1'
import { createMigrationTracker, recordMigrations } from '@vault/storage-d1/test'
import { createVaultRegistry, toProviderScope, scopesForRole } from '@vault/api'
import { mintClerkToken } from '@vault/api/test/clerk'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { NOW, clerkKit, clerkUser, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[CORE84]]: OAuth discovery on D1 ([[CORE64]] D21, D22). Two public documents that answer before bootstrap and migrations, and a
// `WWW-Authenticate` challenge on every 401 when a provider is configured.

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
})

const BASE = 'https://w.test'
const VIBASE = '/.well-known/vibase'
const PRM = '/.well-known/oauth-protected-resource'
const CLI = 'cli_client_test'
const NAMES = MIGRATIONS.map((m) => m.name)
const challenge = (origin: string) => `Bearer resource_metadata="${origin}${PRM}"`

const worker = (extra: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_CLI_CLIENT_ID: CLI, ...extra }, { fetch: kit.fetch })
const get = (wk: { fetch(r: Request): Promise<Response> }, path: string, headers: Record<string, string> = {}, base = BASE, method = 'GET') =>
  wk.fetch(new Request(base + path, { method, headers }))
const boot = () => bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: kit.issuer.issuer }, { now: NOW, newId: () => uuidv7(NOW) })
const tracker = async (names: readonly string[]) => {
  await createMigrationTracker(w.d1)
  await recordMigrations(w.d1, names)
}
const declared = createVaultRegistry().declaredScopes()

describe('D21 GET /.well-known/vibase', () => {
  it('answers the documented shape on the request origin, and a different origin gives a different body', async () => {
    const wk = worker()
    const res = await get(wk, VIBASE)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    const body = (a: string) => ({
      api: `${a}/api/v1`,
      openapi: { api: `${a}/api/v1/openapi.json`, meta: `${a}/meta/v1/openapi.json` },
      auth: { provider: 'clerk', issuer: kit.issuer.issuer, cli_client_id: CLI, protected_resource_metadata: `${a}${PRM}` },
    })
    expect(await res.json()).toEqual(body(BASE))
    expect(await (await get(wk, VIBASE, {}, 'http://localhost:8787')).json()).toEqual(body('http://localhost:8787'))
  })

  it('AUTH_PROVIDER unset: auth is null; AUTH_CLI_CLIENT_ID unset: cli_client_id is null and the rest is unchanged', async () => {
    const none = (await (await get(worker({ AUTH_PROVIDER: undefined }), VIBASE)).json()) as any
    expect(none.auth).toBeNull()
    expect(none.api).toBe(`${BASE}/api/v1`)
    const noCli = (await (await get(worker({ AUTH_CLI_CLIENT_ID: undefined }), VIBASE)).json()) as any
    expect(noCli.auth).toEqual({ provider: 'clerk', issuer: kit.issuer.issuer, cli_client_id: null, protected_resource_metadata: `${BASE}${PRM}` })
  })
})

describe('D22 GET /.well-known/oauth-protected-resource', () => {
  it('resource, authorization_servers, bearer methods and every declared scope under its provider name', async () => {
    const res = await get(worker(), PRM)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toEqual({
      resource: BASE,
      authorization_servers: [kit.issuer.issuer],
      scopes_supported: declared.map(toProviderScope),
      bearer_methods_supported: ['header'],
    })
    // human-only scopes are included: a scope a member does not hold is still advertised
    const humanOnly = declared.filter((s) => !scopesForRole('member', declared).toStrings().includes(s))
    expect(humanOnly.length).toBeGreaterThan(0)
    for (const s of humanOnly) expect(body.scopes_supported).toContain(toProviderScope(s))
    expect((await (await get(worker(), PRM, {}, 'http://localhost:8787')).json() as any).resource).toBe('http://localhost:8787')
  })

  it('without a provider the document is 404 not_found (nothing to point at)', async () => {
    const res = await get(worker({ AUTH_PROVIDER: undefined }), PRM)
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('not_found')
  })
})

describe('both documents are public and cacheable', () => {
  it.each([VIBASE, PRM])('%s: 200 with no credentials and with a garbage Authorization header, no WWW-Authenticate', async (path) => {
    const wk = worker()
    for (const headers of [{}, { authorization: 'Bearer garbage' }, { authorization: 'Bearer a.b.c' }, { authorization: 'Basic !!' }]) {
      const res = await get(wk, path, headers)
      expect(res.status).toBe(200)
      expect(res.headers.get('www-authenticate')).toBeNull()
    }
  })
  it.each([VIBASE, PRM])('%s: Cache-Control public, max-age=60; HEAD answers the headers without a body', async (path) => {
    const wk = worker()
    const res = await get(wk, path)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const head = await get(wk, path, {}, BASE, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await head.text()).toBe('')
  })
  it('a trailing slash and other methods keep today\'s behaviour (no marker: 503 not_initialised)', async () => {
    const wk = worker()
    expect((await get(wk, VIBASE + '/')).status).toBe(503)
    expect((await get(wk, VIBASE, {}, BASE, 'POST')).status).toBe(503)
    expect((await get(wk, '/.well-known/other')).status).toBe(503)
  })
})

describe('gate exemptions', () => {
  it('no deployment marker: both documents 200, an API route 503 not_initialised', async () => {
    const wk = worker()
    await tracker(NAMES)
    expect((await get(wk, VIBASE)).status).toBe(200)
    expect((await get(wk, PRM)).status).toBe(200)
    const api = await get(wk, '/api/v1/contacts')
    expect(api.status).toBe(503)
    expect(((await api.json()) as any).error.code).toBe('not_initialised')
  })
  it('behind the migration manifest: both documents 200, an API route 503 migrations_pending', async () => {
    await boot()
    await tracker(NAMES.slice(0, -1))
    const wk = worker()
    expect((await get(wk, VIBASE)).status).toBe(200)
    expect((await get(wk, PRM)).status).toBe(200)
    const api = await get(wk, '/api/v1/contacts')
    expect(api.status).toBe(503)
    expect(((await api.json()) as any).error.code).toBe('migrations_pending')
  })
})

describe('bad configuration still wins', () => {
  it.each([
    ['missing CLERK_JWT_KEY', { CLERK_JWT_KEY: undefined }],
    ['blank AUTH_CLI_CLIENT_ID', { AUTH_CLI_CLIENT_ID: '  ' }],
    ['unknown AUTH_PROVIDER', { AUTH_PROVIDER: 'nope' }],
  ])('%s: both documents are 500 internal', async (_n, extra) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wk = worker(extra as Partial<D1WorkerEnv>)
    for (const path of [VIBASE, PRM]) {
      const res = await get(wk, path)
      expect(res.status).toBe(500)
      expect(((await res.json()) as any).error.code).toBe('internal')
    }
    vi.restoreAllMocks()
  })
})

describe('WWW-Authenticate on every 401 with a provider (D22)', () => {
  const expectChallenge = async (res: Response, origin = BASE) => {
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(challenge(origin))
  }
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('missing, malformed, expired, foreign and garbage tokens, a bad API key and a disabled agent', async () => {
    quiet()
    const { key } = await boot()
    await tracker(NAMES)
    const wk = worker()
    const api = '/api/v1/contacts'
    await expectChallenge(await get(wk, api))
    await expectChallenge(await get(wk, api, { authorization: 'Bearer a.b.c' }))
    await expectChallenge(await get(wk, api, { authorization: 'Bearer garbage' }))
    await expectChallenge(await get(wk, api, { authorization: 'Bearer vk_unknown_key' }))
    const old = Math.floor(NOW.getTime() / 1000) - 3600
    const expired = await mintClerkToken(kit.issuer, { sub: 'user_a', extra: { vibase_role: 'owner' }, exp: old, now: new Date(NOW.getTime() - 7200_000) })
    await expectChallenge(await get(wk, api, { authorization: `Bearer ${expired}` }))
    const foreign = await mintClerkToken(kit.issuer, { sub: 'user_a', extra: { vibase_role: 'owner' }, iss: 'https://evil.example' })
    await expectChallenge(await get(wk, api, { authorization: `Bearer ${foreign}` }))
    await expectChallenge(await get(wk, '/meta/v1/me'), BASE)
    // a disabled agent's key
    expect((await get(wk, api, { authorization: `Bearer ${key}` })).status).toBe(200)
    await w.d1.prepare('update agents set disabled_at = ?').bind(NOW.toISOString()).run()
    await expectChallenge(await get(wk, api, { authorization: `Bearer ${key}` }))
    // the origin is the request's
    await expectChallenge(await get(wk, api, {}, 'http://localhost:8787'), 'http://localhost:8787')
  })

  it('a 403 carries no challenge', async () => {
    await boot()
    await tracker(NAMES)
    kit.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'a@x.test', verified: true }))
    const tok = await mintClerkToken(kit.issuer, { sub: 'user_a', extra: { vibase_role: 'stranger' } })
    const res = await get(worker(), '/api/v1/contacts', { authorization: `Bearer ${tok}` })
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('a 200 and a 404 carry none', async () => {
    const { key } = await boot()
    await tracker(NAMES)
    const wk = worker()
    const ok = await get(wk, '/api/v1/contacts', { authorization: `Bearer ${key}` })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('www-authenticate')).toBeNull()
    expect((await get(wk, '/api/v1/nope', { authorization: `Bearer ${key}` })).headers.get('www-authenticate')).toBeNull()
  })

  it('AUTH_PROVIDER unset: an API-key 401 carries no challenge', async () => {
    quiet()
    await boot()
    await tracker(NAMES)
    const wk = worker({ AUTH_PROVIDER: undefined })
    for (const headers of [{}, { authorization: 'Bearer vk_unknown_key' }]) {
      const res = await get(wk, '/api/v1/contacts', headers)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBeNull()
    }
  })
})

describe('CORS', () => {
  it('both documents allow any origin, without credentials', async () => {
    const wk = worker({ CORS_ALLOWED_ORIGINS: 'https://app.example' })
    for (const path of [VIBASE, PRM]) {
      for (const origin of ['https://mcp.client.example', 'https://app.example']) {
        const res = await get(wk, path, { origin })
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
        expect(res.headers.get('access-control-allow-credentials')).toBeNull()
      }
    }
  })
  it('an allowed origin can read WWW-Authenticate on a 401; a disallowed one gets no CORS headers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await boot()
    await tracker(NAMES)
    const wk = worker({ CORS_ALLOWED_ORIGINS: 'https://app.example' })
    const ok = await get(wk, '/api/v1/contacts', { origin: 'https://app.example' })
    expect(ok.status).toBe(401)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(ok.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('www-authenticate')
    const no = await get(wk, '/api/v1/contacts', { origin: 'https://evil.example' })
    expect(no.headers.get('access-control-allow-origin')).toBeNull()
  })
})
