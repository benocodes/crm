import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { wellKnown } from './test/fixtures.js'
import { fakeIssuer, network, type FakeIssuerOptions } from './test/fake-issuer.js'
import { fakeInstance, json, rig } from './test/harness.js'

// [[CORE283]] D12, P4: issuer discovery by RFC 8414 path insertion first (appended form only on a non-200, a 200 naming another issuer refused), and `resource` sent on device
// authorization, polling and refresh when `/.well-known/vibase` names one. Stubbed fetch only: the CLI refuses a non-https issuer, so this is never E2E.

const SERVER = 'https://vibase.test'
const RESOURCE = SERVER
const ME = { principal: { id: 'p1', kind: 'user' }, user: { id: 'p1' }, active_organization: { id: 'o1', role: 'owner', scopes: ['contacts:read'] } }
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})

function world(o: { issuer?: FakeIssuerOptions; resource?: string | null; clerkShape?: boolean } = {}) {
  const iss = fakeIssuer({ origin: SERVER, ...o.issuer })
  const inst = fakeInstance({
    wellKnown: (origin) =>
      wellKnown(origin, {
        auth: {
          provider: o.clerkShape ? 'clerk' : 'better-auth',
          issuer: iss.issuer,
          cli_client_id: iss.clientId,
          ...(o.resource === null || o.resource === undefined ? {} : { resource: o.resource }),
          protected_resource_metadata: origin + '/.well-known/oauth-protected-resource',
        },
      }),
    routes: (req) => {
      const u = new URL(req.url)
      if (u.pathname === '/.well-known/oauth-protected-resource') return json({ resource: u.origin, authorization_servers: [iss.issuer], scopes_supported: ['contacts:read'], bearer_methods_supported: ['header'] })
      if (u.pathname === '/meta/v1/me') return json(ME)
      return undefined
    },
  })
  // the instance and the issuer share an origin here (a path issuer): the issuer's handler answers its own paths, the instance everything else
  const net = network({
    [SERVER]: async (req) => {
      const p = new URL(req.url).pathname
      return p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/auth/') || p.startsWith('/oauth/') ? iss.handler(req) : inst.fetch(req)
    },
  })
  const r = rig({ fetch: net.fetch })
  rigs.push(r)
  return { iss, net, r }
}
type W = ReturnType<typeof world>
const login = (w: W) => w.r.run(['login', '--server', SERVER])
const form = (body: string) => Object.fromEntries(new URLSearchParams(body))
const metadataGets = (w: W) => w.net.traffic.filter((t) => t.path.includes('/.well-known/oauth-authorization-server')).map((t) => t.path)

describe('issuer discovery (D12)', () => {
  it('a path issuer is fetched by RFC 8414 path insertion first: one request when it answers', async () => {
    const w = world({ issuer: { issuerPath: '/auth', serves: ['insertion'] } })
    expect((await login(w)).code).toBe(0)
    expect(metadataGets(w)).toEqual(['/.well-known/oauth-authorization-server/auth'])
  })

  it('the appended form is tried only after the insertion URL answers a non-200', async () => {
    const w = world({ issuer: { issuerPath: '/auth', serves: ['appended'] } })
    expect((await login(w)).code).toBe(0)
    expect(metadataGets(w)).toEqual(['/.well-known/oauth-authorization-server/auth', '/auth/.well-known/oauth-authorization-server'])
  })

  it('a 200 at the insertion URL naming another issuer is refused, and the appended form is never tried', async () => {
    const w = world({ issuer: { issuerPath: '/auth', serves: ['insertion', 'appended'], insertionIssuer: 'https://other.test/auth' } })
    const res = await login(w)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('issuer_mismatch')
    expect(metadataGets(w)).toEqual(['/.well-known/oauth-authorization-server/auth'])
  })

  it('neither URL answering 200 is a discovery failure naming both', async () => {
    const w = world({ issuer: { issuerPath: '/auth', serves: [] } })
    const res = await login(w)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('discovery_failed')
    expect(metadataGets(w)).toEqual(['/.well-known/oauth-authorization-server/auth', '/auth/.well-known/oauth-authorization-server'])
  })

  it('a root issuer makes exactly one request, as before', async () => {
    const w = world()
    expect((await login(w)).code).toBe(0)
    expect(metadataGets(w)).toEqual(['/.well-known/oauth-authorization-server'])
  })
})

describe('resource (P4)', () => {
  const posts = (w: W, path: string) => w.net.traffic.filter((t) => t.method === 'POST' && t.path === path).map((t) => form(t.body))

  it('device authorization, every poll and a refresh carry resource when discovery names one', async () => {
    const w = world({ resource: RESOURCE, issuer: { script: ['pending', 'ok'] } })
    expect((await login(w)).code).toBe(0)
    expect(posts(w, '/oauth/device_authorization').map((f) => f.resource)).toEqual([RESOURCE])
    expect(posts(w, '/oauth/token').map((f) => f.resource)).toEqual([RESOURCE, RESOURCE])
    const stored = JSON.parse(readFileSync(w.r.configFile, 'utf8')).profiles.default
    expect(stored.resource).toBe(RESOURCE)
    w.r.advance(stored.expires_at - w.r.now() - 1000)
    expect((await w.r.run(['me', 'get'])).code).toBe(0)
    const refreshes = posts(w, '/oauth/token').filter((f) => f.grant_type === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]!.resource).toBe(RESOURCE)
  })

  it('without a resource in discovery (Clerk) no request has a resource field and the profile stores none', async () => {
    const w = world({ clerkShape: true, issuer: { script: ['pending', 'ok'] } })
    expect((await login(w)).code).toBe(0)
    const stored = JSON.parse(readFileSync(w.r.configFile, 'utf8')).profiles.default
    expect('resource' in stored).toBe(false)
    w.r.advance(stored.expires_at - w.r.now() - 1000)
    expect((await w.r.run(['me', 'get'])).code).toBe(0)
    for (const path of ['/oauth/device_authorization', '/oauth/token']) for (const f of posts(w, path)) expect(Object.keys(f), path).not.toContain('resource')
    // byte-identical device request body
    expect(w.net.traffic.find((t) => t.path === '/oauth/device_authorization')!.body).toBe('client_id=client_cli&scope=contacts%3Aread+offline_access')
  })
})
