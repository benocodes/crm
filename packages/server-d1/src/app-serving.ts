// [[UI460]] D1, D2, D5 ([[UI443]]): the workspace app (`/home`, its bundle under `/app/`) and the root redirect, from the Workers Static Assets binding, with the app's policy and the security headers on every
// answer. Served for every provider (the page reads its provider from discovery); static: it reads no storage and needs no credential, so it runs before the migration, configuration and control gates.
import { APP_CSP } from '@vibase/ui/csp'
import { APP_BUNDLE, APP_PAGE_PATHS, APP_PREFIX, ASSET_PREFIX, UI_BUNDLE } from './app/paths.js'

export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

const HOME = APP_PAGE_PATHS[0]
const CONNECT = '/connect'
/** Where the build puts the page: the assets directory's `assets/app/index.html`, which the binding serves at its directory path. Reached only through the page paths. */
const INDEX_PATH = `${ASSET_PREFIX}/${APP_BUNDLE}/`

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

/** `/connect` and anything under `/connect/`: nothing else (`/connectx` and `/connect.js` are not ours). The Preact page that lived here is gone ([[UI476]] D10); the path is a redirect to Home. */
const isConnectPath = (pathname: string): boolean => pathname === CONNECT || pathname.startsWith(`${CONNECT}/`)

const isPagePath = (pathname: string): boolean => (APP_PAGE_PATHS as readonly string[]).includes(pathname)
/** A page path, anything below one (`/home/`, `/home/x`: not pages, the Worker's own 404, but ours to answer before the gates) and anything under `/app/`. `/homex` and `/appx` are not ours; `/app` exactly is (a 404, never the binding's directory page). */
const isUnderPage = (pathname: string): boolean => APP_PAGE_PATHS.some((p) => pathname.startsWith(`${p}/`))
const isUnderAppPrefix = (pathname: string): boolean => pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)
/**
 * [[UI504]] D5, P1: what is ours under `/assets`: `/assets` itself, `/assets/` and everything below it except `/assets/ui` and below, which `serveUi` answers (it exists on better-auth only; the caller decides).
 * `/assetsx` is not ours.
 */
const isAssetPath = (pathname: string): boolean =>
  (pathname === ASSET_PREFIX || pathname.startsWith(`${ASSET_PREFIX}/`)) && !isUiAssetPath(pathname)
/** `/assets/ui` and anything under `/assets/ui/`: the auth pages' bundle ([[UI504]] D5). */
export const isUiAssetPath = (pathname: string): boolean =>
  pathname === `${ASSET_PREFIX}/${UI_BUNDLE}` || pathname.startsWith(`${ASSET_PREFIX}/${UI_BUNDLE}/`)
/** True for the exact page paths, anything below them, `/app` and anything under `/app/` (the root is decided by `serveApp`, which only claims `GET`/`HEAD`). */
export const isAppPath = (pathname: string): boolean =>
  isPagePath(pathname) || isUnderPage(pathname) || isUnderAppPrefix(pathname)

const methodNotAllowed = (csp: string) =>
  withHeaders(
    new Response('method not allowed', {
      status: 405,
      headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
    }),
    csp,
  )

const notFound = (csp: string) =>
  withHeaders(
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
    csp,
  )

/** The built file `/assets/app/<file>` names, or undefined for a folder path (`/assets/app`, `/assets/app/`, `/assets/app/x/`), the bundle's `index.html` and anything outside `/assets/app/` ([[UI504]] P1). */
const appAssetFile = (pathname: string): string | undefined => {
  const prefix = `${ASSET_PREFIX}/${APP_BUNDLE}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  return rest === '' || rest.endsWith('/') || rest === 'index.html' ? undefined : pathname
}

/**
 * Answers a request for the root, a page path, under `/app/`, under `/connect` or under `/assets/` (except `/assets/ui/`, [[UI504]]), or `undefined` for any other path (and for a method other than `GET`/`HEAD` on `/`, which stays the Worker's own `404`).
 * `GET`/`HEAD` `/connect` and `/connect/` are `302 /home` with the binding, else `404`; another method on them is `405`; anything else under `/connect/` is the app's JSON `404`, any method ([[UI476]] P2).
 * `GET`/`HEAD` `/` is `302 /home` (the query is dropped) when the binding is there, else `404`; `GET`/`HEAD` of a page path is the one `index.html`; `/app` and everything under `/app/` is the JSON `404`, any method (UI504 P2);
 * `/home/` and `/home/x` are not pages (`404`); another method on those is `405`.
 * `/assets/app/<file>` is the built file (GET/HEAD through the binding, which answers a missing file with its own `404`; another method `405`); `/assets`, `/assets/`, a folder, `index.html` and an unknown bundle are the JSON `404`, any method (P1).
 * Without the binding every `/assets/` path is `404`.
 */
export async function serveApp(
  req: Request,
  opts: { assets?: AssetsLike; issuer?: string },
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const isRoot = url.pathname === '/'
  const isConnect = isConnectPath(url.pathname)
  const isAssets = isAssetPath(url.pathname)
  if (!isRoot && !isConnect && !isAssets && !isAppPath(url.pathname)) return undefined
  const read = req.method === 'GET' || req.method === 'HEAD'
  if (isRoot && !read) return undefined
  const csp = appCsp(opts.issuer)
  // [[UI476]] P2: below `/connect/` nothing is served (the page and its assets are gone), for every method, with or without the binding.
  if (isConnect && url.pathname !== CONNECT && url.pathname !== `${CONNECT}/`) return notFound(csp)
  if (isAssets) {
    if (!opts.assets) return notFound(csp)
    const file = appAssetFile(url.pathname)
    if (!file) return notFound(csp)
    if (!read) return methodNotAllowed(csp)
    return withHeaders(
      await opts.assets.fetch(new Request(new URL(file, url.origin), { method: req.method, headers: req.headers })),
      csp,
    )
  }
  // [[UI504]] P2: `/app` and everything under it is claimed and answers the JSON 404 for any method (until the pages move under it).
  if (isUnderAppPrefix(url.pathname)) return notFound(csp)
  if (!read) return methodNotAllowed(csp)
  if (!opts.assets) return notFound(csp)
  if (isRoot || isConnect) return withHeaders(new Response(null, { status: 302, headers: { location: HOME } }), csp)
  if (!isPagePath(url.pathname)) return notFound(csp)
  return withHeaders(
    await opts.assets.fetch(new Request(new URL(INDEX_PATH, url.origin), { method: req.method, headers: req.headers })),
    csp,
  )
}
