// [[UI460]] D1, D2, D5 ([[UI443]]): the workspace app (`/home`, its bundle under `/app/`) and the root redirect, from the Workers Static Assets binding, with the app's policy and the security headers on every
// answer. Served for every provider (the page reads its provider from discovery); static: it reads no storage and needs no credential, so it runs before the migration, configuration and control gates.
import { APP_CSP } from '@vibase/ui/csp'
import { APP_PAGE_PATHS, APP_PREFIX } from './app/paths.js'

export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

const HOME = APP_PAGE_PATHS[0]
/** Where the build puts the page: the assets directory's `app/index.html`, which the binding serves at its directory path. Reached only through the page paths. */
const INDEX_PATH = `${APP_PREFIX}/`

/**
 * The app's Content-Security-Policy ([[UI443]] D5): `APP_CSP` (`PAGE_CSP` with runtime `<style>` allowed; no nonce). With a Clerk issuer the Clerk script and Frontend API are allowed on top, from Clerk's CSP guide for `clerk-js`
 * without components: the issuer origin and the challenge and protect hosts in `script-src`, `connect-src`, `img-src`, `worker-src` and `frame-src`, and nothing else; `script-src` has neither `'unsafe-inline'` nor `'unsafe-eval'`.
 * With no issuer (Better Auth, no provider) the page loads no Clerk script, so no Clerk host appears.
 */
export function appCsp(issuer?: string): string {
  if (!issuer) return APP_CSP
  const i = new URL(issuer).origin
  const add: Record<string, string> = {
    'script-src': ` ${i} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    'connect-src': ` ${i} https://*.protect.clerk.com:*`,
    'img-src': ' https://img.clerk.com',
  }
  return APP_CSP.split('; ')
    .flatMap((d) => {
      const name = d.split(' ')[0]!
      const out = [d + (add[name] ?? '')]
      if (name === 'img-src')
        out.push("worker-src 'self' blob:", 'frame-src https://challenges.cloudflare.com https://*.protect.clerk.com')
      return out
    })
    .join('; ')
}

function withHeaders(res: Response, csp: string): Response {
  const out = new Response(res.body, res)
  out.headers.set('content-security-policy', csp)
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  if ((out.headers.get('content-type') ?? '').startsWith('text/html')) out.headers.set('cache-control', 'no-store')
  return out
}

const isPagePath = (pathname: string): boolean => (APP_PAGE_PATHS as readonly string[]).includes(pathname)
/** A page path, anything below one (`/home/`, `/home/x`: not pages, the Worker's own 404, but ours to answer before the gates) and anything under `/app/`. `/homex` and `/appx` are not ours; `/app` exactly is (a 404, never the binding's directory page). */
const isUnderPage = (pathname: string): boolean => APP_PAGE_PATHS.some((p) => pathname.startsWith(`${p}/`))
/** True for the exact page paths, anything below them, `/app` and anything under `/app/` (the root is decided by `serveApp`, which only claims `GET`/`HEAD`). */
export const isAppPath = (pathname: string): boolean =>
  isPagePath(pathname) || isUnderPage(pathname) || pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)

const notFound = (csp: string) =>
  withHeaders(
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
    csp,
  )

/**
 * Answers a request for the root, a page path or under `/app/`, or `undefined` for any other path (and for a method other than `GET`/`HEAD` on `/`, which stays the Worker's own `404`).
 * `GET`/`HEAD` `/` is `302 /home` (the query is dropped) when the binding is there, else `404`; `GET`/`HEAD` of a page path is the one `index.html`; `/app/<file>` is the built asset (or the binding's `404`);
 * `/app/`, `/app/index.html`, `/home/` and `/home/x` are not pages (`404`); another method on those is `405`. Without the binding every such path is `404`.
 */
export async function serveApp(
  req: Request,
  opts: { assets?: AssetsLike; issuer?: string },
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const isRoot = url.pathname === '/'
  if (!isRoot && !isAppPath(url.pathname)) return undefined
  const read = req.method === 'GET' || req.method === 'HEAD'
  if (isRoot && !read) return undefined
  const csp = appCsp(opts.issuer)
  if (!read)
    return withHeaders(
      new Response('method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
      }),
      csp,
    )
  if (!opts.assets) return notFound(csp)
  if (isRoot) return withHeaders(new Response(null, { status: 302, headers: { location: HOME } }), csp)
  if (
    !isPagePath(url.pathname) &&
    (isUnderPage(url.pathname) ||
      url.pathname === APP_PREFIX ||
      url.pathname === INDEX_PATH ||
      url.pathname === `${APP_PREFIX}/index.html`)
  )
    return notFound(csp)
  const target = new URL(isPagePath(url.pathname) ? INDEX_PATH : url.pathname, url.origin)
  return withHeaders(await opts.assets.fetch(new Request(target, { method: req.method, headers: req.headers })), csp)
}
