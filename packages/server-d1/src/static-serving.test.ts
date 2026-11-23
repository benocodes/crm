import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import { MIGRATIONS, openControlDb } from '@vibase/storage-d1'
import { APP_CSP } from '@vibase/ui/csp'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { APP_PAGE_PATHS } from './app/paths.js'
import { appCsp } from './static-serving.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { bootstrapD1, clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI460]] D1, D2 (group 1), D5 (group 2): the workspace app is served by the Worker from the assets binding for every provider, before the migration, configuration and control gates,
// with the app's policy and security headers on every answer; `/`, `/app` and `/app/` redirect to `/app/home` ([[UI507]]: the pages are at `/app/<page>`).
const NOT_FOUND = { error: { code: 'not_found', message: 'no such route' } }
const HTML = '<!doctype html><title>app</title>'
// The fake serves the built files under /assets/app/ AND, deliberately, the same files at the root, under /app/ and at the old page paths: a Worker that routed a path to the binding by mistake would answer 200.
const FILES: Record<string, { type: string; body: string }> = {
  '/assets/app/': { type: 'text/html; charset=utf-8', body: HTML },
  '/assets/app/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/assets/app/app.css': { type: 'text/css', body: 'body{}' },
  '/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/index.html': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/home': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/home/': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/home/x': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/unknown': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/app.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/home': { type: 'text/html; charset=utf-8', body: HTML },
  '/home/': { type: 'text/html; charset=utf-8', body: HTML },
  '/accounts': { type: 'text/html; charset=utf-8', body: HTML },
  '/accounts/': { type: 'text/html; charset=utf-8', body: HTML },
  '/agents': { type: 'text/html; charset=utf-8', body: HTML },
  '/agents/': { type: 'text/html; charset=utf-8', body: HTML },
  '/': { type: 'text/html; charset=utf-8', body: HTML },
  // The old connect page's files, deliberately still "in the binding": a Worker that sent /connect* to it (UI476) would answer 200.
  '/connect/': { type: 'text/html; charset=utf-8', body: HTML },
  '/connect/connect.js': { type: 'text/javascript', body: 'console.log(1)' },
  '/connect': { type: 'text/html; charset=utf-8', body: HTML },
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
const isAuthPage = (at: string) => /^\w+ \/app\/(sign-in|invite|reset-password|consent|device)(?=[/?\s])/.test(at)
const isApp = (at: string) => !isAuthPage(at) && /^(GET|HEAD|POST) \/app(?=[/?\s])/.test(at) || /^(GET|HEAD) \/ \(302\)/.test(at)
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
  it('the app has three page paths under /app: /app/home, /app/accounts and /app/agents (UI507 D1)', () => {
    expect([...APP_PAGE_PATHS]).toEqual(['/app/home', '/app/accounts', '/app/agents'])
  })
})

const PAGES = ['/app/home', '/app/accounts', '/app/agents']
describe.each(PROVIDERS)('routing matrix: %s (D1, D2, P4)', (_name, make) => {
  it.each(PAGES)(
    'GET and HEAD %s answer the app index.html from the binding, POST is 405 Allow: GET, HEAD, with the database behind (before the migration gate)',
    async (path) => {
      const wk = make()
      const res = await send(wk, path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/html/)
      expect(await res.text()).toBe(HTML)
      expect(assetCalls).toEqual([{ method: 'GET', path: '/assets/app/' }])
      const head = await send(wk, path, 'HEAD')
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      const post = await send(wk, path, 'POST')
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toBe('GET, HEAD')
    },
  )

  it('a page with a query is still the page', async () => {
    expect((await send(make(), '/app/home?x=1')).status).toBe(200)
  })

  // P4: every other /app/ path is the JSON 404 for any method; the binding is never asked.
  it.each([
    '/app/home/',
    '/app/home/x',
    '/app/accounts/',
    '/app/accounts/x',
    '/app/agents/',
    '/app/agents/x',
    '/app/unknown',
    '/app/app.js',
    '/app/app.css',
    '/app/index.html',
  ])('%s is the JSON 404 for GET, HEAD and POST, and the binding is not asked', async (path) => {
    const wk = make()
    for (const method of ['GET', 'HEAD', 'POST']) {
      const res = await send(wk, path, method)
      expect(res.status, `${method} ${path}`).toBe(404)
      if (method === 'GET') expect(await res.json()).toEqual(NOT_FOUND)
    }
    expect(assetCalls).toEqual([])
  })

  it('/assets/app/app.js and /assets/app/app.css are the assets', async () => {
    const wk = make()
    for (const path of ['/assets/app/app.js', '/assets/app/app.css']) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toBe(FILES[path]!.body)
    }
  })

  it.each(['/', '/app', '/app/', '/?a=1&b=2', '/app?x=1', '/app/?x=1'])(
    'GET and HEAD %s are 302 to /app/home and drop the query',
    async (path) => {
      const wk = make()
      for (const method of ['GET', 'HEAD']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(302)
        expect(res.headers.get('location'), `${method} ${path}`).toBe('/app/home')
      }
      expect(assetCalls).toEqual([])
    },
  )

  it.each(['/app', '/app/'])('POST %s is 405 with Allow: GET, HEAD', async (path) => {
    const res = await send(make(), path, 'POST')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect(res.headers.get('location')).toBeNull()
  })

  it('POST / stays what it was: the Worker own answer for a path nothing serves, never the redirect', async () => {
    const wk = make()
    const post = await send(wk, '/', 'POST')
    expect(post.status).toBe((await send(wk, '/nothing-here', 'POST')).status)
    expect(post.status).not.toBe(302)
    expect(post.headers.get('location')).toBeNull()
    expect(assetCalls).toEqual([])
  })

  it('without the assets binding every /app path and / is 404, any method', async () => {
    const wk = make({ ASSETS: undefined })
    for (const path of [...PAGES, '/app', '/app/', '/app/home/x', '/assets/app/app.js', '/']) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('location'), path).toBeNull()
    }
    for (const path of [...PAGES, '/app', '/app/'])
      expect((await send(wk, path, 'POST')).status, `POST ${path}`).toBe(404)
  })
})

// [[UI507]] D6, P5: the old page paths and /connect are ordinary unknown paths: 404 on a ready Worker, 503 before the migrations, never a page or a redirect. The binding fake still holds files at /home and /connect on purpose.
describe('the old paths are gone (D6 app half, P5)', () => {
  const OLD = ['/home', '/accounts', '/agents', '/home/x', '/connect', '/connect?x=1', '/connect/x', '/connect/']
  const ready = async () => {
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
  }
  it('a ready better-auth Worker answers 404 (never 302 or 200) for GET, HEAD and POST, with no app policy, and never asks the binding', async () => {
    await ready()
    const wk = betterAuthWorker()
    for (const path of OLD)
      for (const method of ['GET', 'HEAD', 'POST']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.headers.get('location'), `${method} ${path}`).toBeNull()
        expect(res.headers.get('content-security-policy'), `${method} ${path}`).toBeNull()
      }
    expect(assetCalls).toEqual([])
  })

  it('with the database behind they are the gate answer (503), not a page or a redirect', async () => {
    const wk = betterAuthWorker()
    for (const path of OLD) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(503)
      expect(res.headers.get('location'), path).toBeNull()
    }
    expect(assetCalls).toEqual([])
  })

  it('/connectx and /connect.js are ordinary unknown paths too', async () => {
    for (const path of ['/connectx', '/connect.js']) expect((await send(betterAuthWorker(), path)).status).not.toBe(302)
  })
})

// UI510 P3: off better-auth the auth pages are the JSON 404 for any method (with the app's headers), the binding is never asked; the app pages stay served.
describe.each([
  ['clerk', clerkWorker],
  ['no provider', unsetWorker],
])('auth pages are no pages on %s (UI510 P3)', (_name, make) => {
  it.each(['/app/sign-in', '/app/invite', '/app/reset-password', '/app/consent', '/app/device'])(
    '%s is the JSON 404 for GET, HEAD and POST with the app policy',
    async (path) => {
      const wk = make()
      for (const method of ['GET', 'HEAD', 'POST']) {
        const res = await send(wk, path, method)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.headers.get('content-security-policy'), `${method} ${path}`).toBe(appCsp(clerkIssuer))
        if (method === 'GET') expect(await res.json()).toEqual(NOT_FOUND)
      }
      expect(assetCalls).toEqual([])
    },
  )
  it('the app pages are still served', async () => {
    expect((await send(make(), '/app/home')).status).toBe(200)
  })
})

describe('the redirect and the pages answer before the gates (D2)', () => {
  it('with the database behind and a misconfigured provider, / and /app are still 302 /app/home', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wk = betterAuthWorker({ AUTH_SECRET: 'too short' })
    expect((await send(wk, '/meta/v1/me')).status).not.toBe(302)
    for (const path of ['/', '/app', '/app/']) {
      const res = await send(wk, path)
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location'), path).toBe('/app/home')
    }
  })
  it('a misconfigured provider still serves /app/home (before the configuration gate)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(betterAuthWorker({ AUTH_SECRET: 'too short' }), '/app/home')
    expect(res.status).toBe(200)
  })
  it('the database being behind does not stop /app/home, while the API answers 503', async () => {
    const wk = betterAuthWorker()
    expect(((await (await send(wk, '/health')).json()) as any).migrations.status).toBe('behind')
    expect((await send(wk, '/app/home')).status).toBe(200)
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
      ['/app/home', 'GET'],
      ['/app/home', 'HEAD'],
      ['/assets/app/app.js', 'GET'],
      ['/app/', 'GET'],
      ['/app/home/x', 'GET'],
      ['/app/home', 'POST'],
      ['/', 'GET'],
    ] as const)
      await send(wk, path, method)
    expect(seen.length).toBe(7)
  })

  it('on Clerk the composed Worker hands the issuer to the policy', async () => {
    const res = await send(clerkWorker(), '/app/home')
    expect(res.headers.get('content-security-policy')).toBe(appCsp(kit.issuer.issuer))
    expect(res.headers.get('content-security-policy')).toContain(new URL(kit.issuer.issuer).origin)
  })

  it('per provider, the composed Worker serves /app/home under APP_CSP (no issuer) or APP_CSP plus the issuer origin and the Clerk hosts (UI476 P3, carried from connect-csp-providers)', async () => {
    const SELF_ONLY =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    for (const make of [betterAuthWorker, unsetWorker]) {
      const csp = (await send(make(), '/app/home')).headers.get('content-security-policy')!
      expect(csp).toBe(SELF_ONLY)
      expect(csp).not.toMatch(/clerk|challenges\.cloudflare\.com|\/auth|vibase\.test/)
    }
    const i = new URL(kit.issuer.issuer).origin
    expect((await send(clerkWorker(), '/app/home')).headers.get('content-security-policy')).toBe(
      `default-src 'self'; script-src 'self' ${i} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ${i} https://*.protect.clerk.com:*; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    )
  })

  it('the auth pages keep PAGE_CSP, without unsafe-inline styles', async () => {
    const res = await send(betterAuthWorker(), '/app/sign-in')
    expect(res.headers.get('content-security-policy')).not.toContain("'unsafe-inline'")
  })
})

describe('connectCsp is gone (P4)', () => {
  it('no source file under src (tests aside) names the old symbol', async () => {
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
  })
})
