import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseTrustedOrigins } from '../src/auth-config.js'
import { APP_PAGE_PATHS } from '../src/app/paths.js'
import { UI_PAGE_PATHS } from '../src/ui-serving.js'
import { DEV_PORT, devOwnedPaths, startDevServer, WORKER_PORT, type DevServer } from './dev-server.js'

// [[UI489]] D5, D6 (group 4): the dev server owns the page paths (iterated from the constants), the page sources and Vite's own paths, and proxies every other request to the local Worker unchanged.
interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}
let upstream: Server
let dev: DevServer
const seen: Seen[] = []
const lastSeen = (): Seen => seen.at(-1)!

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() })
      if (req.url === '/connect') {
        res.writeHead(302, { location: '/home', 'set-cookie': ['sid=abc; Path=/; HttpOnly', 'second=2'] })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'upstream' })
      res.end(`upstream:${req.method}:${req.url}`)
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  dev = await startDevServer({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, port: 0 })
}, 60_000)
afterAll(async () => {
  await dev?.close()
  await new Promise((r) => upstream?.close(r))
})

const get = (path: string, init?: RequestInit) => fetch(`${dev.url}${path}`, { redirect: 'manual', ...init })

describe('the constants and the owned set', () => {
  it('the ports are 5173 (dev server) and 8787 (Worker)', () => {
    expect([DEV_PORT, WORKER_PORT]).toEqual([5173, 8787])
  })

  it('the owned page paths are exactly the two constants, never a third list (P1), and own neither the root nor /connect', () => {
    expect(devOwnedPaths().sort()).toEqual([...APP_PAGE_PATHS, ...UI_PAGE_PATHS].sort())
    expect(devOwnedPaths()).not.toContain('/')
    expect(devOwnedPaths()).not.toContain('/connect')
  })
})

describe('pages and sources are the dev server’s own', () => {
  it.each([
    ...APP_PAGE_PATHS.map((p) => [p, '/assets/app/main.tsx'] as const),
    ...UI_PAGE_PATHS.map((p) => [p, '/assets/ui/main.tsx'] as const),
  ])('%s answers its page’s HTML with the Vite client, its own entry module, and no CSP', async (path, entry) => {
    const before = seen.length
    const res = await get(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(res.headers.get('content-security-policy')).toBeNull()
    const html = await res.text()
    expect(html).toContain('/@vite/client')
    expect(html).toContain(`src="${entry}"`)
    expect(html).toContain('id="root"')
    expect(seen.length, 'the page never reaches the upstream').toBe(before)
  })

  it('a page path with a query is still the page', async () => {
    const res = await get(`${UI_PAGE_PATHS[0]}?return_to=%2Fhome`)
    expect(await res.text()).toContain('/@vite/client')
  })

  it.each(['/assets/app/main.tsx', '/assets/ui/main.tsx'])(
    '%s answers a transformed module (JSX compiled, imports rewritten)',
    async (path) => {
      const before = seen.length
      const res = await get(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/javascript/)
      const js = await res.text()
      expect(js).not.toMatch(/<[A-Z]\w+[ />]/)
      expect(js).toContain('_jsxDEV')
      expect(seen.length).toBe(before)
    },
    60_000,
  )

  it('a component module answers with React Fast Refresh wired (import.meta.hot)', async () => {
    const res = await get('/assets/app/app.tsx')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('import.meta.hot')
  }, 60_000)

  it('Vite’s own client path is Vite’s', async () => {
    const before = seen.length
    const res = await get('/assets/@vite/client')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('createHotContext')
    expect(seen.length).toBe(before)
  })
})

describe('everything else reaches the Worker as sent', () => {
  it.each(['/', '/connect', '/.well-known/vibase', '/mcp', '/app', '/meta', '/app/main.tsx', '/ui/main.tsx'])(
    'GET %s is proxied',
    async (path) => {
      const res = await get(path)
      expect(lastSeen().url).toBe(path)
      if (path !== '/connect') {
        expect(res.status).toBe(200)
        expect(await res.text()).toBe(`upstream:GET:${path}`)
      }
    },
  )

  it('a POST keeps method, path, query, body, Origin and Cookie', async () => {
    const res = await get('/api/contacts?x=1', {
      method: 'POST',
      body: '{"name":"Ada"}',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
        cookie: 'sid=abc',
        authorization: 'Bearer t',
      },
    })
    expect(await res.text()).toBe('upstream:POST:/api/contacts?x=1')
    const s = lastSeen()
    expect(s.method).toBe('POST')
    expect(s.body).toBe('{"name":"Ada"}')
    expect(s.headers.origin).toBe('http://localhost:5173')
    expect(s.headers.cookie).toBe('sid=abc')
    expect(s.headers.authorization).toBe('Bearer t')
    expect(s.headers['content-type']).toBe('application/json')
  })

  it('a 302 with Location and Set-Cookie comes back unfollowed', async () => {
    const res = await get('/connect')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/home')
    expect(res.headers.getSetCookie()).toEqual(['sid=abc; Path=/; HttpOnly', 'second=2'])
  })

  it('the upstream’s own headers come back', async () => {
    expect((await get('/meta')).headers.get('x-from')).toBe('upstream')
  })
})

describe('.dev.vars.example names the dev origin (D6)', () => {
  const text = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8')
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]

  it('AUTH_TRUSTED_ORIGINS parses through the Worker’s parser and includes http://localhost:5173', () => {
    expect(value('AUTH_TRUSTED_ORIGINS')).toBeDefined()
    expect(parseTrustedOrigins(value('AUTH_TRUSTED_ORIGINS'), 'http://localhost:8787')).toContain(
      'http://localhost:5173',
    )
  })

  it('CLERK_AUTHORIZED_PARTIES lists both the API origin and the dev origin', () => {
    const parties = value('CLERK_AUTHORIZED_PARTIES')!.split(',')
    expect(parties).toContain('http://localhost:8787')
    expect(parties).toContain('http://localhost:5173')
  })
})
