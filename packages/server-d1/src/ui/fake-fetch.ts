// Test support for the page suites ([[UI246]] D9): `fetch` faked at the page's boundary. Not a test file; never imported by a page.
import { vi } from 'vitest'

export interface Call {
  method: string
  path: string
  body: unknown
  init: RequestInit
}
export interface Reply {
  status: number
  json?: unknown
  text?: string
}
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>)

/** `routes` is keyed `METHOD /path`. A request with no route throws, so an unexpected call fails the test that made it. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost:8787')
    const method = (init.method ?? 'GET').toUpperCase()
    const call: Call = { method, path: url.pathname, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, init }
    const key = `${method} ${url.pathname}`
    // [[CORE294]]: the sign-in and invite pages read discovery for the Google button. It answers password only unless a suite routes it, and is kept out of `calls` so the pages' own request lists stay what they were.
    if (key === 'GET /.well-known/vibase' && !routes[key]) return new Response(JSON.stringify({ auth: { sign_in_methods: ['password'] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (key !== 'GET /.well-known/vibase') calls.push(call)
    const h = routes[key]
    if (!h) throw new Error(`unexpected request ${method} ${url.pathname}`)
    const r = typeof h === 'function' ? await h(call) : h
    return new Response(r.text ?? (r.json === undefined ? null : JSON.stringify(r.json)), { status: r.status, headers: r.text === undefined && r.json !== undefined ? { 'content-type': 'application/json' } : {} })
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn, requests: () => calls.map((c) => `${c.method} ${c.path}`) }
}
