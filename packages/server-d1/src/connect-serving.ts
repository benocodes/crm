// [[UI30]] D1, D2, D9: `/connect*` on the API origin, from the Workers Static Assets binding, with the security headers on every response.
export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

const PREFIX = '/connect'

/**
 * The Content Security Policy of the page ([[UI30]] D9), from Clerk's CSP guide for `clerk-js` without components. `<I>` is the
 * `CLERK_ISSUER` origin: it serves the script and the Frontend API. `'unsafe-inline'` is only in `style-src` (clerk-js sets runtime styles);
 * `script-src` has neither `'unsafe-inline'` nor `'unsafe-eval'`. With no provider the page loads no Clerk script, so no Clerk host appears.
 */
export function connectCsp(issuer?: string): string {
  const directives = issuer
    ? (() => {
        const i = new URL(issuer).origin
        return [
          "default-src 'self'",
          `script-src 'self' ${i} https://challenges.cloudflare.com https://*.protect.clerk.com`,
          `connect-src 'self' ${i} https://*.protect.clerk.com:*`,
          "img-src 'self' https://img.clerk.com",
          "worker-src 'self' blob:",
          "style-src 'self' 'unsafe-inline'",
          'frame-src https://challenges.cloudflare.com https://*.protect.clerk.com',
        ]
      })()
    : ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "img-src 'self'", "style-src 'self'"]
  return [...directives, "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ')
}

function withHeaders(res: Response, csp: string): Response {
  const out = new Response(res.body, res)
  out.headers.set('content-security-policy', csp)
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  if ((out.headers.get('content-type') ?? '').startsWith('text/html')) out.headers.set('cache-control', 'no-store')
  return out
}

/** True for `/connect` and anything under `/connect/`: nothing else ([[UI30]] D2: `/connectx` and `/connect.js` are not ours). */
export const isConnectPath = (pathname: string): boolean => pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)

/**
 * Answers a `/connect*` request, or `undefined` for any other path. `GET`/`HEAD` `/connect` is the page; `/connect/` is `308` to
 * `/connect`; `/connect/<file>` is the asset (the build puts every file under `connect/`, so the asset path is the request path) or the
 * binding's `404`. Without the binding every `/connect*` is `404`. It reads no storage and needs no credential, so it runs before every gate.
 */
export async function serveConnect(req: Request, opts: { assets?: AssetsLike; issuer?: string }): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (!isConnectPath(url.pathname)) return undefined
  const csp = connectCsp(opts.issuer)
  const reply = (res: Response) => withHeaders(res, csp)
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } }))
  if (url.pathname === `${PREFIX}/`) return reply(new Response(null, { status: 308, headers: { location: `${PREFIX}${url.search}` } }))
  if (!opts.assets) return reply(new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  // The page itself is the asset directory's index, reached at `/connect/` (the binding's own redirect would send `/connect` there anyway).
  const target = new URL(url.pathname === PREFIX ? `${PREFIX}/` : url.pathname, url.origin)
  return reply(await opts.assets.fetch(new Request(target, { method: req.method, headers: req.headers })))
}
