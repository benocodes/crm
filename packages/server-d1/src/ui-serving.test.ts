import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigrationTracker } from '@vibase/storage-d1/test'
import { openControlDb } from '@vibase/storage-d1'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { UI_CSP, UI_PAGE_PATHS } from './ui-serving.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI246]] D1, D2: the three auth pages and the `/ui/` bundle are served by the Worker from the assets binding, on `better-auth` only, with the security headers on every response,
// before the migration, configuration and control gates; on `clerk` and unset every one of those paths is `404 not_found`.
const NOT_FOUND = { error: { code: 'not_found', message: 'no such route' } }
const EXACT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
const HTML = '<!doctype html><title>auth</title>'
const PAGES = ['/sign-in', '/invite', '/reset-password', '/consent', '/device']
const ASSET_PATHS = ['/ui/app.js', '/ui/ui.css']
// The fake serves the built files under /ui/ AND, deliberately, the same files (and the pages) at the root: a Worker that routed a path to the assets binding by mistake would answer 200.
const FILES: Record<string, { type: string; body: string }> = {
  '/ui/': { type: 'text/html; charset=utf-8', body: HTML },
  '/ui/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/ui/ui.css': { type: 'text/css', body: 'body{}' },
  '/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/sign-in': { type: 'text/html; charset=utf-8', body: HTML },
  '/invite': { type: 'text/html; charset=utf-8', body: HTML },
  '/reset-password': { type: 'text/html; charset=utf-8', body: HTML },
  '/consent': { type: 'text/html; charset=utf-8', body: HTML },
  '/device': { type: 'text/html; charset=utf-8', body: HTML },
}
const assetCalls: { method: string; path: string }[] = []
const ASSETS = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    assetCalls.push({ method: req.method, path: url.pathname })
    const f = FILES[url.pathname]
    if (!f) return new Response('Not found', { status: 404 })
    return new Response(req.method === 'HEAD' ? null : f.body, { status: 200, headers: { 'content-type': f.type, etag: '"x"' } })
  },
}

let w: WorkerPair
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerPair()
  kit = await clerkKit()
}, 60_000)
afterAll(() => w.dispose())

let n = 0
const seen: { at: string; res: Response }[] = []
let headerRules = true
const send = async (wk: { fetch(r: Request, ctx?: unknown): Promise<Response> }, path: string, method = 'GET', headers: Record<string, string> = {}) => {
  const res = await wk.fetch(new Request(AUTH_BASE + path, { method, headers: { 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`, ...headers }, redirect: 'manual' }))
  seen.push({ at: `${method} ${path} (${res.status})`, res })
  return res
}

beforeEach(async () => {
  await w.reset()
  assetCalls.length = 0
  seen.length = 0
  headerRules = true
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
})
// Every page and bundle response of a better-auth test (HTML, HEAD, script, stylesheet, 404, 405) carries the exact policy.
afterEach(() => {
  if (headerRules) {
    for (const { at, res } of seen) {
      if (!PAGES.some((p) => at.includes(` ${p} `)) && !at.includes(' /ui/')) continue
      expect(res.headers.get('content-security-policy'), at).toBe(EXACT_CSP)
      expect(res.headers.get('x-content-type-options'), at).toBe('nosniff')
      expect(res.headers.get('referrer-policy'), at).toBe('strict-origin-when-cross-origin')
      if ((res.headers.get('content-type') ?? '').startsWith('text/html')) expect(res.headers.get('cache-control'), at).toBe('no-store')
    }
  }
  vi.restoreAllMocks()
})

const betterAuthWorker = (over: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE, ASSETS, ...over })
const clerkWorker = () => composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ASSETS }, { fetch: kit.fetch })
const unsetWorker = () => composeD1Worker({ DB: w.d1, ASSETS })

describe('the constants the Worker serves (D1, D2)', () => {
  it('the policy is the exact string of D2', () => {
    expect(UI_CSP).toBe(EXACT_CSP)
  })
  it('the page paths are the five exact paths (UI247 D1 adds /consent and /device)', () => {
    expect([...UI_PAGE_PATHS]).toEqual(PAGES)
  })
})

describe('serving matrix: path x provider (D1, D2)', () => {
  it.each([...PAGES, ...ASSET_PATHS])('better-auth: GET %s is served from the assets binding, with the headers, before the migration gate (the database is behind)', async (path) => {
    const wk = betterAuthWorker()
    expect(((await (await send(wk, '/health')).json()) as any).migrations.status).toBe('behind')
    const res = await send(wk, path)
    expect(res.status).toBe(200)
    const isPage = PAGES.includes(path)
    expect(res.headers.get('content-type')).toMatch(isPage ? /^text\/html/ : /^text\/(javascript|css)/)
    expect(await res.text()).toBe(FILES[isPage ? '/ui/' : path]!.body)
    expect(assetCalls).toEqual([{ method: 'GET', path: isPage ? '/ui/' : path }])
    expect((await send(wk, '/meta/v1/me')).status).toBe(503)
  })

  it.each([...PAGES, ...ASSET_PATHS])('better-auth: HEAD %s is 200 with the headers and no body', async (path) => {
    const res = await send(betterAuthWorker(), path, 'HEAD')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it.each([
    ['clerk', clerkWorker],
    ['unset', unsetWorker],
  ])('%s: every page path and asset path is 404 not_found and the assets binding is never asked', async (_name, make) => {
    headerRules = false
    const wk = make()
    for (const path of [...PAGES, ...ASSET_PATHS, '/ui/', '/ui/index.html']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.headers.get('content-security-policy'), `${method} ${path}`).toBeNull()
        if (method === 'GET') expect(await res.json(), path).toEqual(NOT_FOUND)
      }
    }
    expect(assetCalls).toEqual([])
  })

  it('an empty AUTH_PROVIDER is the same 404 as unset', async () => {
    headerRules = false
    for (const path of [...PAGES, ...ASSET_PATHS]) {
      const res = await send(composeD1Worker({ DB: w.d1, AUTH_PROVIDER: '', ASSETS }), path)
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toEqual(NOT_FOUND)
    }
  })

  it('a bad better-auth configuration still serves the static pages (they answer before the configuration gate)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(betterAuthWorker({ AUTH_SECRET: 'too short' }), '/sign-in')
    expect(res.status).toBe(200)
  })

  it('without the assets binding every page and asset path is 404 (headers included)', async () => {
    const wk = betterAuthWorker({ ASSETS: undefined })
    for (const path of [...PAGES, ...ASSET_PATHS]) expect((await send(wk, path)).status, path).toBe(404)
  })
})

describe('exact paths and methods (D1: a trailing slash is not a page, pinned here)', () => {
  it.each(['/sign-in/', '/invite/', '/reset-password/', '/consent/', '/device/', '/devices', '/device/x', '/consent.html', '/sign-in/x', '/sign-inx', '/invite.html', '/reset-password/abc'])('%s is not a page: the assets binding is not asked and nothing is served', async (path) => {
    headerRules = false
    const res = await send(betterAuthWorker(), path)
    expect(assetCalls).toEqual([])
    // The Worker's own answer for a path that is no page (here the database is behind, so the migration gate speaks): never the page.
    expect(res.status).not.toBe(200)
    expect(res.headers.get('content-type')).not.toMatch(/^text\/html/)
  })

  it('/ui/ and /ui/index.html are not pages (the page is reached only at its three paths); an unknown /ui/x is the assets binding\'s 404 with the headers', async () => {
    const wk = betterAuthWorker()
    expect((await send(wk, '/ui/')).status).toBe(404)
    expect((await send(wk, '/ui/index.html')).status).toBe(404)
    expect(assetCalls).toEqual([])
    const res = await send(wk, '/ui/nope.js')
    expect(res.status).toBe(404)
    expect(assetCalls).toEqual([{ method: 'GET', path: '/ui/nope.js' }])
  })

  it.each(['/sign-in', '/ui/app.js'])('POST %s is 405 with Allow: GET, HEAD, without asking the assets binding', async (path) => {
    const res = await send(betterAuthWorker(), path, 'POST')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect(assetCalls).toEqual([])
  })

  it('no asset is reachable outside the three paths and /ui/: /app.js, /index.html and / never reach the assets binding', async () => {
    headerRules = false
    for (const path of ['/app.js', '/index.html', '/']) {
      const res = await send(betterAuthWorker(), path)
      expect(res.status, path).not.toBe(200)
    }
    expect(assetCalls).toEqual([])
  })
})

describe('with a paired, bootstrapped better-auth instance', () => {
  beforeEach(async () => {
    const { recordMigrations } = await import('@vibase/storage-d1/test')
    const { MIGRATIONS } = await import('@vibase/storage-d1')
    await recordMigrations(w.d1, MIGRATIONS.map((m) => m.name))
    await bootstrapD1(w.d1, { organizationName: 'Acme', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: AUTH_BASE, ownerEmail: 'owner@x.test' }, { control: openControlDb(w.control) })
  })

  it.each(['/sign-in/', '/invite/', '/reset-password/', '/consent/', '/device/'])('%s (trailing slash) is the Worker\'s 404 not_found, not a page', async (path) => {
    const res = await send(betterAuthWorker(), path)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(assetCalls).toEqual([])
  })

  it('/auth/* still reaches Better Auth', async () => {
    const res = await send(betterAuthWorker(), '/auth/ok')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('an unauthenticated OAuth authorize request redirects to /sign-in (the provider\'s loginPage)', async () => {
    const wk = betterAuthWorker()
    const reg = await wk.fetch(
      new Request(`${AUTH_BASE}/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: AUTH_BASE, 'cf-connecting-ip': '203.0.113.77' },
        body: JSON.stringify({ client_name: 'Pages test', token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], redirect_uris: ['http://127.0.0.1:33418/cb'], scope: 'openid' }),
      }),
    )
    expect(reg.status, await reg.clone().text()).toBe(201)
    const { client_id } = (await reg.json()) as { client_id: string }
    const q = new URLSearchParams({ client_id, response_type: 'code', redirect_uri: 'http://127.0.0.1:33418/cb', scope: 'openid', state: 'xyz', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: AUTH_BASE })
    const res = await send(wk, `/auth/oauth2/authorize?${q}`)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!, AUTH_BASE)
    expect(location.origin + location.pathname).toBe(`${AUTH_BASE}/sign-in`)
  })
})
