import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { PAGE_CSP } from '@vibase/ui/csp'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { appCsp } from './app-serving.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { bootstrapD1, clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI504]] cycle 1 (D3, D4, D5, D6 asset halves; planner rules P1, P2): the built files are served at /assets/<bundle>/<file> and nowhere else.
// `/assets/app/` for every provider under the app's policy, `/assets/ui/` only on better-auth under PAGE_CSP; a folder, index.html, an unknown bundle or a disabled bundle is the JSON 404 for any method;
// a file is GET/HEAD through the binding, any other method 405; the old file paths answer 404.
const NOT_FOUND = { error: { code: 'not_found', message: 'no such route' } }
const HTML = '<!doctype html><title>x</title>'
// The fake holds the built files at their URL paths AND, deliberately, the old-layout files and the folder/index paths: a Worker that routed any of them to the binding would answer 200.
const FILES: Record<string, { type: string; body: string }> = {
  '/assets/app/': { type: 'text/html; charset=utf-8', body: HTML },
  '/assets/app/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/assets/app/app.js': { type: 'text/javascript', body: 'app-js' },
  '/assets/app/app.css': { type: 'text/css', body: 'app-css' },
  '/assets/ui/': { type: 'text/html; charset=utf-8', body: HTML },
  '/assets/ui/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/assets/ui/app.js': { type: 'text/javascript', body: 'ui-js' },
  '/assets/ui/ui.css': { type: 'text/css', body: 'ui-css' },
  '/assets/other/app.js': { type: 'text/javascript', body: 'other' },
  '/assets/stray.js': { type: 'text/javascript', body: 'stray' },
  '/ui/app.js': { type: 'text/javascript', body: 'old' },
  '/ui/ui.css': { type: 'text/css', body: 'old' },
  '/ui/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/ui/': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/app.js': { type: 'text/javascript', body: 'old' },
  '/app/app.css': { type: 'text/css', body: 'old' },
  '/app/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/': { type: 'text/html; charset=utf-8', body: HTML },
}
const assetCalls: { method: string; path: string }[] = []
const ASSETS = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    assetCalls.push({ method: req.method, path: url.pathname })
    const f = FILES[url.pathname]
    if (!f) return new Response('Not found', { status: 404 })
    return new Response(req.method === 'HEAD' ? null : f.body, {
      status: 200,
      headers: { 'content-type': f.type, etag: '"x"' },
    })
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
const send = (wk: { fetch(r: Request, ctx?: unknown): Promise<Response> }, path: string, method = 'GET') =>
  wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: { 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}` },
      redirect: 'manual',
    }),
  )

beforeEach(async () => {
  await w.reset()
  assetCalls.length = 0
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
})

const betterAuth = (over: Partial<D1WorkerEnv> = {}) =>
  composeD1Worker({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
    ASSETS,
    ...over,
  })
const clerk = () =>
  composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ASSETS }, { fetch: kit.fetch })
const unset = () => composeD1Worker({ DB: w.d1, ASSETS })

type Provider = 'better-auth' | 'clerk' | 'unset'
const make = (p: Provider) => (p === 'better-auth' ? betterAuth() : p === 'clerk' ? clerk() : unset())
const PROVIDERS: Provider[] = ['better-auth', 'clerk', 'unset']
const APP_POLICY = (p: Provider) => (p === 'clerk' ? appCsp(kit.issuer.issuer) : appCsp())
const expectHeaders = (res: Response, csp: string, at: string) => {
  expect(res.headers.get('content-security-policy'), at).toBe(csp)
  expect(res.headers.get('x-content-type-options'), at).toBe('nosniff')
  expect(res.headers.get('referrer-policy'), at).toBe('strict-origin-when-cross-origin')
  expect(res.headers.get('cache-control'), at).not.toBe('no-store')
}

describe.each(PROVIDERS)('/assets/app/ (any provider): %s', (p) => {
  it.each(['/assets/app/app.js', '/assets/app/app.css'])(
    'GET and HEAD %s is the file, under the app policy, no no-store',
    async (path) => {
      const wk = make(p)
      for (const method of ['GET', 'HEAD']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(200)
        expect(await res.text()).toBe(method === 'GET' ? FILES[path]!.body : '')
        expectHeaders(res, APP_POLICY(p), `${method} ${path}`)
      }
      expect(assetCalls).toEqual([
        { method: 'GET', path },
        { method: 'HEAD', path },
      ])
    },
  )

  it("a missing file is the binding's 404, with the app's headers", async () => {
    const res = await send(make(p), '/assets/app/nope.js')
    expect(res.status).toBe(404)
    expectHeaders(res, APP_POLICY(p), 'nope')
    expect(assetCalls).toEqual([{ method: 'GET', path: '/assets/app/nope.js' }])
  })

  it('a page is the bundle index fetched through the binding folder path, with no-store on the HTML only', async () => {
    const res = await send(make(p), '/home')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toBe(APP_POLICY(p))
    expect(assetCalls).toEqual([{ method: 'GET', path: '/assets/app/' }])
  })

  it.each(['POST', 'PUT', 'DELETE'])(
    '%s /assets/app/app.js is 405 with Allow: GET, HEAD, the binding not asked',
    async (method) => {
      const res = await send(make(p), '/assets/app/app.js', method)
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD')
      expect(assetCalls).toEqual([])
    },
  )
})

describe.each(PROVIDERS)('P1 404s under /assets/ (JSON, any method, binding not asked): %s', (p) => {
  const common = [
    '/assets',
    '/assets/',
    '/assets/app',
    '/assets/app/',
    '/assets/app/index.html',
    '/assets/other/app.js',
    '/assets/stray.js',
    '/assets/nope/',
  ]
  const uiRows = ['/assets/ui', '/assets/ui/', '/assets/ui/index.html']
  const rows = p === 'better-auth' ? [...common, ...uiRows] : common
  it.each(rows)('%s', async (path) => {
    const wk = make(p)
    for (const method of ['GET', 'HEAD', 'POST']) {
      const res = await send(wk, path, method)
      expect(res.status, `${method} ${path}`).toBe(404)
      if (method === 'GET') expect(await res.json(), path).toEqual(NOT_FOUND)
    }
    expect(assetCalls).toEqual([])
  })
})

describe('/assets/ui/ is better-auth only (D5)', () => {
  it.each(['/assets/ui/app.js', '/assets/ui/ui.css'])(
    'better-auth: GET and HEAD %s is the file under PAGE_CSP, POST is 405',
    async (path) => {
      const wk = betterAuth()
      for (const method of ['GET', 'HEAD']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(200)
        expect(await res.text()).toBe(method === 'GET' ? FILES[path]!.body : '')
        expectHeaders(res, PAGE_CSP, `${method} ${path}`)
      }
      const post = await send(wk, path, 'POST')
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toBe('GET, HEAD')
      expect(assetCalls.map((c) => c.method)).toEqual(['GET', 'HEAD'])
    },
  )

  it("better-auth: a missing ui file is the binding's 404, with the page headers", async () => {
    const res = await send(betterAuth(), '/assets/ui/nope.js')
    expect(res.status).toBe(404)
    expectHeaders(res, PAGE_CSP, 'nope')
  })

  it.each([
    ['clerk', clerk],
    ['unset', unset],
  ])('%s: every /assets/ui/ file path is the JSON 404 for any method, the binding not asked', async (_n, mk) => {
    const wk = mk()
    for (const path of ['/assets/ui/app.js', '/assets/ui/ui.css', '/assets/ui/nope.js']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(404)
        if (method === 'GET') expect(await res.json()).toEqual(NOT_FOUND)
      }
    }
    expect(assetCalls).toEqual([])
  })

  it('the two bundles carry their own policies (never swapped)', async () => {
    const ui = await send(betterAuth(), '/assets/ui/app.js')
    const app = await send(betterAuth(), '/assets/app/app.js')
    expect(ui.headers.get('content-security-policy')).toBe(PAGE_CSP)
    expect(app.headers.get('content-security-policy')).toBe(appCsp())
    expect(PAGE_CSP).not.toBe(appCsp())
  })
})

describe('without the binding every /assets/ path is 404', () => {
  it.each(['/assets/app/app.js', '/assets/app/app.css', '/assets/ui/app.js', '/assets', '/assets/'])(
    '%s',
    async (path) => {
      for (const wk of [betterAuth({ ASSETS: undefined }), composeD1Worker({ DB: w.d1 })]) {
        for (const method of ['GET', 'HEAD', 'POST'])
          expect((await send(wk, path, method)).status, `${method} ${path}`).toBe(404)
      }
    },
  )
})

// [[UI504]] D6 asset half, P2: the old file paths answer 404, never 200, though the binding fake (deliberately) still holds files there.
describe('the old file paths are gone (D6, P2)', () => {
  const OLD_APP = ['/app/app.js', '/app/app.css', '/app/index.html']
  const OLD_UI = ['/ui/app.js', '/ui/ui.css', '/ui/index.html']

  it.each(PROVIDERS)('%s: /app/<file> is the static JSON 404, the binding not asked', async (p) => {
    const wk = make(p)
    for (const path of OLD_APP) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toEqual(NOT_FOUND)
    }
    expect(assetCalls).toEqual([])
  })

  it('/ui/<file> reaches the router as an ordinary unknown path: 404 on a ready Worker, the binding not asked', async () => {
    await recordMigrations(
      w.d1,
      MIGRATIONS.map((m) => m.name),
    )
    await bootstrapD1(
      w.d1,
      {
        organizationName: 'Acme',
        authProvider: 'better-auth',
        authOrgId: 'better-auth',
        publicBaseUrl: AUTH_BASE,
        ownerEmail: 'owner@x.test',
      },
      { control: openControlDb(w.control) },
    )
    const wk = betterAuth()
    for (const path of OLD_UI) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-security-policy'), path).toBeNull()
    }
    expect(assetCalls).toEqual([])
  })
})
