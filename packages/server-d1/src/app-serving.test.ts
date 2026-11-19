import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigrationTracker } from '@vibase/storage-d1/test'
import { APP_CSP } from '@vibase/ui/csp'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { APP_PAGE_PATHS } from './app/paths.js'
import { appCsp } from './app-serving.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI460]] D1, D2 (group 1), D5 (group 2): the workspace app is served by the Worker from the assets binding for every provider, before the migration, configuration and control gates,
// with the app's policy and security headers on every answer; `/` redirects to `/home`.
const NOT_FOUND = { error: { code: 'not_found', message: 'no such route' } }
const HTML = '<!doctype html><title>app</title>'
// The fake serves the built files under /app/ AND, deliberately, the same files at the root and under /home: a Worker that routed a path to the binding by mistake would answer 200.
const FILES: Record<string, { type: string; body: string }> = {
  '/app/': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/app/app.css': { type: 'text/css', body: 'body{}' },
  '/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/home': { type: 'text/html; charset=utf-8', body: HTML },
  '/home/': { type: 'text/html; charset=utf-8', body: HTML },
  '/accounts': { type: 'text/html; charset=utf-8', body: HTML },
  '/accounts/': { type: 'text/html; charset=utf-8', body: HTML },
  '/agents': { type: 'text/html; charset=utf-8', body: HTML },
  '/agents/': { type: 'text/html; charset=utf-8', body: HTML },
  '/': { type: 'text/html; charset=utf-8', body: HTML },
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
/** Set by `clerkWorker`: the issuer the composed Worker was given, so the header rule knows which policy to expect. */
let clerkIssuer: string | undefined
const seen: { at: string; res: Response; issuer?: string }[] = []
const send = async (wk: { fetch(r: Request, ctx?: unknown): Promise<Response> }, path: string, method = 'GET') => {
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: { 'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}` },
      redirect: 'manual',
    }),
  )
  seen.push({ at: `${method} ${path} (${res.status})`, res, issuer: clerkIssuer })
  return res
}

beforeEach(async () => {
  await w.reset()
  assetCalls.length = 0
  seen.length = 0
  clerkIssuer = undefined
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1) // the database is behind: every gate would answer 503 if the app route came after it
})
const isApp = (at: string) => /^(GET|HEAD|POST) \/(home|accounts|agents|app)/.test(at) || /^(GET|HEAD) \/ \(302\)/.test(at)
// D5: every app answer (page, asset, 404, 405, 302) carries the policy, nosniff and the referrer policy; HTML is no-store.
afterEach(() => {
  for (const { at, res, issuer } of seen) {
    if (!isApp(at)) continue
    expect(res.headers.get('content-security-policy'), at).toBe(appCsp(issuer))
    expect(res.headers.get('x-content-type-options'), at).toBe('nosniff')
    expect(res.headers.get('referrer-policy'), at).toBe('strict-origin-when-cross-origin')
    if ((res.headers.get('content-type') ?? '').startsWith('text/html'))
      expect(res.headers.get('cache-control'), at).toBe('no-store')
  }
  vi.restoreAllMocks()
})

const betterAuthWorker = (over: Partial<D1WorkerEnv> = {}) =>
  composeD1Worker({
    DB: w.d1,
    CONTROL_DB: w.control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
    ASSETS,
    ...over,
  })
const clerkWorker = (over: Partial<D1WorkerEnv> = {}) => {
  clerkIssuer = kit.issuer.issuer
  return composeD1Worker(
    { DB: w.d1, CONTROL_DB: w.control, ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ASSETS, ...over },
    { fetch: kit.fetch },
  )
}
const unsetWorker = (over: Partial<D1WorkerEnv> = {}) =>
  composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, ASSETS, ...over })
const PROVIDERS: [string, (over?: Partial<D1WorkerEnv>) => ReturnType<typeof composeD1Worker>][] = [
  ['clerk', clerkWorker],
  ['better-auth', betterAuthWorker],
  ['no provider', unsetWorker],
]

describe('the constants the Worker serves (D1)', () => {
  it('the app has three page paths: /home, /accounts and /agents (UI459 D1)', () => {
    expect([...APP_PAGE_PATHS]).toEqual(['/home', '/accounts', '/agents'])
  })
})

describe.each(PROVIDERS)('routing matrix: %s (D1, D2)', (_name, make) => {
  it('GET and HEAD /home answer the app index.html from the binding, with the database behind (before the migration gate)', async () => {
    const wk = make()
    const res = await send(wk, '/home')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe(HTML)
    expect(assetCalls).toEqual([{ method: 'GET', path: '/app/' }])
    const head = await send(wk, '/home', 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('GET and HEAD /accounts answer the app index.html like /home, with the policy (UI467 D1)', async () => {
    const wk = make()
    const res = await send(wk, '/accounts')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
    expect(assetCalls).toEqual([{ method: 'GET', path: '/app/' }])
    expect((await send(wk, '/accounts', 'HEAD')).status).toBe(200)
    expect((await send(wk, '/accounts', 'POST')).status).toBe(405)
  })

  it('GET and HEAD /agents answer the app index.html like /home, with the policy (UI459 D1)', async () => {
    const wk = make()
    const res = await send(wk, '/agents')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
    expect(assetCalls).toEqual([{ method: 'GET', path: '/app/' }])
    expect((await send(wk, '/agents', 'HEAD')).status).toBe(200)
    expect((await send(wk, '/agents', 'POST')).status).toBe(405)
  })

  it.each(['/agents/', '/agents/x'])("%s is the Worker's 404 not_found (UI459 D1)", async (path) => {
    const res = await send(make(), path)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
    expect(assetCalls).toEqual([])
  })

  it.each(['/accounts/', '/accounts/x'])("%s is the Worker's 404 not_found (UI467 D1)", async (path) => {
    const res = await send(make(), path)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND)
    expect(assetCalls).toEqual([])
  })

  it('/app/app.js and /app/app.css are the assets', async () => {
    const wk = make()
    for (const path of ['/app/app.js', '/app/app.css']) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toBe(FILES[path]!.body)
    }
  })

  it.each(['/app', '/app/', '/app/index.html', '/home/', '/home/x'])(
    "%s is the Worker's 404 not_found, and the binding is not asked for the page",
    async (path) => {
      const res = await send(make(), path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND)
      expect(assetCalls).toEqual([])
    },
  )

  it.each(['/home', '/app'])('POST %s is 405 with Allow: GET, HEAD', async (path) => {
    const res = await send(make(), path, 'POST')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect(assetCalls).toEqual([])
  })

  it('GET and HEAD / is 302 to /home and drops the query; POST / is 404', async () => {
    const wk = make()
    for (const method of ['GET', 'HEAD']) {
      const res = await send(wk, '/?a=1&b=2', method)
      expect(res.status, method).toBe(302)
      expect(res.headers.get('location'), method).toBe('/home')
    }
    // POST / stays what it was: the Worker's own answer for a path nothing serves (404, or its gate's 503 here, with the database behind), never the redirect.
    const post = await send(wk, '/', 'POST')
    expect(post.status).toBe((await send(wk, '/nothing-here', 'POST')).status)
    expect(post.status).not.toBe(302)
    expect(post.headers.get('location')).toBeNull()
    expect(assetCalls).toEqual([])
  })

  it('without the assets binding every app path and / is 404', async () => {
    const wk = make({ ASSETS: undefined })
    for (const path of ['/home', '/accounts', '/agents', '/app/app.js', '/app/app.css', '/']) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('location'), path).toBeNull()
    }
  })
})

describe('before the gates (D1)', () => {
  it('a misconfigured provider still serves /home (it answers before the configuration gate)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(betterAuthWorker({ AUTH_SECRET: 'too short' }), '/home')
    expect(res.status).toBe(200)
  })
  it('the database being behind does not stop /home, while the API answers 503', async () => {
    const wk = betterAuthWorker()
    expect(((await (await send(wk, '/health')).json()) as any).migrations.status).toBe('behind')
    expect((await send(wk, '/home')).status).toBe(200)
    expect((await send(wk, '/meta/v1/me')).status).toBe(503)
  })
})

describe('appCsp and the headers (D5, group 2)', () => {
  it('appCsp() and appCsp on Better Auth equal APP_CSP exactly', () => {
    expect(appCsp()).toBe(APP_CSP)
    expect(appCsp(undefined)).toBe(APP_CSP)
  })

  it('on Clerk it adds the issuer and the Clerk hosts to script-src, connect-src, img-src, worker-src and frame-src, and nothing else; script-src has no unsafe-*', () => {
    const issuer = 'https://clerk.example.test/'
    const i = 'https://clerk.example.test'
    const csp = appCsp(issuer)
    const dirs = (s: string) => Object.fromEntries(s.split('; ').map((d) => [d.split(' ')[0]!, d]))
    const base = dirs(APP_CSP)
    const clerk = dirs(csp)
    expect(clerk['script-src']).toBe(
      `script-src 'self' ${i} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    )
    expect(clerk['connect-src']).toBe(`connect-src 'self' ${i} https://*.protect.clerk.com:*`)
    expect(clerk['img-src']).toBe("img-src 'self' https://img.clerk.com")
    expect(clerk['worker-src']).toBe("worker-src 'self' blob:")
    expect(clerk['frame-src']).toBe('frame-src https://challenges.cloudflare.com https://*.protect.clerk.com')
    const changed = ['script-src', 'connect-src', 'img-src', 'worker-src', 'frame-src']
    for (const name of Object.keys(base)) if (!changed.includes(name)) expect(clerk[name], name).toBe(base[name])
    expect(Object.keys(clerk).sort()).toEqual([...Object.keys(base), 'worker-src', 'frame-src'].sort())
    expect(clerk['style-src']).toBe("style-src 'self' 'unsafe-inline'")
    expect(clerk['script-src']).not.toMatch(/unsafe-/)
  })

  it('every app answer through the composed Worker carries the policy: page, HEAD, asset, 404, 405, 302 (checked after each test)', async () => {
    const wk = betterAuthWorker()
    for (const [path, method] of [
      ['/home', 'GET'],
      ['/home', 'HEAD'],
      ['/app/app.js', 'GET'],
      ['/app/', 'GET'],
      ['/home/x', 'GET'],
      ['/home', 'POST'],
      ['/', 'GET'],
    ] as const)
      await send(wk, path, method)
    expect(seen.length).toBe(7)
  })

  it('on Clerk the composed Worker hands the issuer to the policy', async () => {
    const res = await send(clerkWorker(), '/home')
    expect(res.headers.get('content-security-policy')).toBe(appCsp(kit.issuer.issuer))
    expect(res.headers.get('content-security-policy')).toContain(new URL(kit.issuer.issuer).origin)
  })

  it('the auth pages keep PAGE_CSP, without unsafe-inline styles', async () => {
    const res = await send(betterAuthWorker(), '/sign-in')
    expect(res.headers.get('content-security-policy')).not.toContain("'unsafe-inline'")
  })
})

describe('connectCsp is gone (P4)', () => {
  it('no source file under src (tests aside) names the old symbol, and connect-serving imports appCsp', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
    const old = ['connect', 'Csp'].join('')
    const hits = walk(dir).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && readFileSync(f, 'utf8').includes(old),
    )
    expect(hits).toEqual([])
    expect(readFileSync(join(dir, 'connect-serving.ts'), 'utf8')).toContain('appCsp')
  })
})
