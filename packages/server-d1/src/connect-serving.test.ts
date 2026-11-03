import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { clerkKit, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[UI30]] D1, D2, D9: `/connect*` is served from the assets binding by the Worker, with the security headers on every response.

let w: WorkerD1
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  seen.length = 0
  assetCalls.length = 0
})

const BASE = 'https://w.test'
const HTML = '<!doctype html><title>connect</title>'
// The fake serves the built page under /connect/ AND, deliberately, the same files at the root: a Worker that routed
// every path to the assets binding would then answer 200 for them, so the outside-path tests can fail.
const FILES: Record<string, { type: string; body: string }> = {
  '/connect/': { type: 'text/html; charset=utf-8', body: HTML },
  '/connect/connect.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/': { type: 'text/html; charset=utf-8', body: HTML },
  '/connect.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/index.html': { type: 'text/html; charset=utf-8', body: HTML },
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

const worker = (extra: Partial<D1WorkerEnv> = {}) => composeD1Worker({ DB: w.d1, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ASSETS, ...extra }, { fetch: kit.fetch })
/** Every `/connect*` response of a test, so the afterEach can hold each of them to the header rules. */
const seen: { path: string; method: string; res: Response }[] = []
const isConnect = (p: string) => p === '/connect' || p.startsWith('/connect/')
const get = async (wk: { fetch(r: Request): Promise<Response> }, path: string, method = 'GET', headers: Record<string, string> = {}) => {
  const res = await wk.fetch(new Request(BASE + path, { method, headers, redirect: 'manual' }))
  if (isConnect(path)) seen.push({ path, method, res })
  return res
}

const I = () => new URL(kit.issuer.issuer).origin
const csp = (i: string) =>
  `default-src 'self'; script-src 'self' ${i} https://challenges.cloudflare.com https://*.protect.clerk.com; connect-src 'self' ${i} https://*.protect.clerk.com:*; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
const NO_PROVIDER_CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
let expectedCsp = (): string => csp(I())

// D9: the same header rules on every response kind of every test (HTML, HEAD, asset, 308, 404, 405).
afterEach(() => {
  for (const { path, method, res } of seen) {
    const at = `${method} ${path} (${res.status})`
    expect(res.headers.get('content-security-policy'), at).toBe(expectedCsp())
    expect(res.headers.get('x-content-type-options'), at).toBe('nosniff')
    expect(res.headers.get('referrer-policy'), at).toBe('strict-origin-when-cross-origin')
    const csp = res.headers.get('content-security-policy')!
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!
    expect(script, at).not.toMatch(/unsafe-/)
    expect(csp, at).toContain("frame-ancestors 'none'")
    if ((res.headers.get('content-type') ?? '').startsWith('text/html')) expect(res.headers.get('cache-control'), at).toBe('no-store')
  }
  expectedCsp = () => csp(I())
  vi.restoreAllMocks()
})

describe('D1 serving', () => {
  it('GET /connect is 200 HTML from the assets binding (the index), before any bootstrap or migration', async () => {
    const res = await get(worker(), '/connect')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe(HTML)
    expect(assetCalls).toEqual([{ method: 'GET', path: '/connect/' }])
  })

  it('HEAD /connect is 200 with the headers and no body', async () => {
    const res = await get(worker(), '/connect', 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('')
  })

  it('/connect/ redirects 308 to /connect, without asking the assets binding', async () => {
    const res = await get(worker(), '/connect/')
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('/connect')
    expect(assetCalls).toEqual([])
  })

  it('a built asset is served under /connect/ with its own content type', async () => {
    const res = await get(worker(), '/connect/connect.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('an unknown /connect/x is the assets binding\'s 404', async () => {
    const res = await get(worker(), '/connect/nope')
    expect(res.status).toBe(404)
    expect(assetCalls).toEqual([{ method: 'GET', path: '/connect/nope' }])
  })

  it('another method is 405 with Allow: GET, HEAD', async () => {
    const res = await get(worker(), '/connect', 'POST')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect(assetCalls).toEqual([])
  })

  it('without the assets binding /connect and /connect/x are 404 (headers included)', async () => {
    const wk = worker({ ASSETS: undefined })
    expect((await get(wk, '/connect')).status).toBe(404)
    expect((await get(wk, '/connect/connect.js')).status).toBe(404)
  })

  it('a bad configuration still serves the page (it is static), with no provider host in the policy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expectedCsp = () => NO_PROVIDER_CSP
    const res = await get(worker({ AUTH_PROVIDER: 'nope' }), '/connect')
    expect(res.status).toBe(200)
  })
})

describe('no asset is reachable outside /connect*', () => {
  const outside = ['/connect.js', '/index.html', '/', '/connectx', '/connect-assets/connect.js', '/api/connect.js']
  it.each(outside)('%s is not served from assets: the assets binding is not asked, and the answer is the Worker\'s own', async (path) => {
    const res = await worker().fetch(new Request(BASE + path))
    expect(assetCalls).toEqual([])
    expect(res.status).not.toBe(200)
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('/health, /api/v1, /meta/v1 and /.well-known answer as before', async () => {
    const wk = worker()
    expect((await wk.fetch(new Request(BASE + '/health'))).status).toBe(200)
    const api = await wk.fetch(new Request(BASE + '/api/v1/contacts'))
    expect(api.status).toBe(503)
    expect(((await api.json()) as any).error.code).toBe('not_initialised')
    expect((await wk.fetch(new Request(BASE + '/meta/v1/openapi.json'))).status).toBe(200)
    const doc = await wk.fetch(new Request(BASE + '/.well-known/vibase'))
    expect(doc.status).toBe(200)
    expect(((await doc.json()) as any).api).toBe(`${BASE}/api/v1`)
    expect(assetCalls).toEqual([])
  })
})

describe('D9 headers', () => {
  it('the policy is built from CLERK_ISSUER: the issuer origin in script-src and connect-src, exactly as chartered', async () => {
    const res = await get(worker(), '/connect')
    expect(res.headers.get('content-security-policy')).toBe(csp(I()))
    expect(csp(I())).toContain(I())
  })

  it('a different issuer gives a different policy', async () => {
    const other = 'https://clerk.other.example'
    expectedCsp = () => csp(other)
    const res = await get(worker({ CLERK_ISSUER: other }), '/connect')
    expect(res.headers.get('content-security-policy')).not.toContain(I())
  })

  it('with no provider no Clerk host appears and style-src carries no unsafe-inline', async () => {
    expectedCsp = () => NO_PROVIDER_CSP
    for (const path of ['/connect', '/connect/connect.js', '/connect/', '/connect/nope']) {
      const res = await get(worker({ AUTH_PROVIDER: undefined }), path)
      const policy = res.headers.get('content-security-policy')!
      expect(policy).not.toMatch(/clerk|cloudflare|unsafe-/)
    }
  })

  it('no-store is on the HTML and the asset keeps its own caching headers', async () => {
    expect((await get(worker(), '/connect')).headers.get('cache-control')).toBe('no-store')
    expect((await get(worker(), '/connect/connect.js')).headers.get('etag')).toBe('"x"')
  })
})
