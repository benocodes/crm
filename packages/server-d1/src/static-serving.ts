// [[UI510]] D5 ([[UI504]]): the one static serving entry for `/`, `/app` and `/assets`: the workspace app's pages, the auth pages and both bundles' files, from the Workers Static Assets binding, with each bundle's policy and the security headers
// on every answer. Static: it reads no storage and needs no credential, so it runs before the migration, configuration and control gates. The app's pages exist for every provider (the page reads its provider from discovery); the auth pages
// and `/assets/ui/` only for the built-in provider (`builtIn`), elsewhere they are the JSON `404`.
import { APP_CSP, PAGE_CSP } from '@vibase/ui/csp'
import { APP_BUNDLE, APP_PREFIX, ASSET_PREFIX, PAGE_TABLE, UI_BUNDLE } from './app/paths.js'

export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

const HOME = PAGE_TABLE[0]!.path
/** The auth pages' policy ([[UI246]] D2): no third-party script, no inline script or style, same-origin API calls and forms only. One value with the React gallery's run ([[UI445]] D6). */
export const UI_CSP: string = PAGE_CSP

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

/** `/app` itself, `/app/` and anything under `/app/`. `/appx` is not ours. */
export const isAppPath = (pathname: string): boolean => pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)
/** `/assets` itself, `/assets/` and everything below it. `/assetsx` is not ours. */
const isAssetPath = (pathname: string): boolean => pathname === ASSET_PREFIX || pathname.startsWith(`${ASSET_PREFIX}/`)
/** `/assets/ui` and anything under `/assets/ui/`: the auth pages' bundle. */
const isUiAssetPath = (pathname: string): boolean =>
  pathname === `${ASSET_PREFIX}/${UI_BUNDLE}` || pathname.startsWith(`${ASSET_PREFIX}/${UI_BUNDLE}/`)

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

/** The built file `/assets/<bundle>/<file>` names, or undefined for a folder path, the bundle's `index.html` and anything outside it ([[UI504]] P1). */
const assetFile = (pathname: string, bundle: string): string | undefined => {
  const prefix = `${ASSET_PREFIX}/${bundle}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  return rest === '' || rest.endsWith('/') || rest === 'index.html' ? undefined : pathname
}

/**
 * Answers a request for the root, under `/app` or under `/assets`, or `undefined` for any other path (and for a method other than `GET`/`HEAD` on `/`, which stays the Worker's own `404`).
 * `GET`/`HEAD` of `/`, `/app` and `/app/` is `302 /app/home` (the query is dropped), another method on `/app` and `/app/` is `405`; `GET`/`HEAD` of a table page is its bundle's `index.html` with that bundle's policy, another method `405`
 * ([[UI507]] P4, [[UI510]] P3); every other `/app/` path is the JSON `404`, any method. An auth page, and every `/assets/ui` path, off the built-in provider is the JSON `404`, any method. Without the binding every path here is `404`, any method.
 * `/assets/<bundle>/<file>` is the built file (GET/HEAD through the binding, which answers a missing file with its own `404`; another method `405`); `/assets`, `/assets/`, a folder, `index.html` and an unknown bundle are the JSON `404`, any method.
 * The old page paths (`/home`, `/connect`, `/sign-in`, ...) are not claimed: the router answers them as any unknown path.
 */
export async function serveStatic(
  req: Request,
  opts: { assets?: AssetsLike; issuer?: string; builtIn: boolean },
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const path = url.pathname
  const isRoot = path === '/'
  const isAssets = isAssetPath(path)
  if (!isRoot && !isAssets && !isAppPath(path)) return undefined
  const read = req.method === 'GET' || req.method === 'HEAD'
  if (isRoot && !read) return undefined
  const appPolicy = appCsp(opts.issuer)
  const forward = (target: string) =>
    opts.assets!.fetch(new Request(new URL(target, url.origin), { method: req.method, headers: req.headers }))
  if (isAssets) {
    const ui = isUiAssetPath(path)
    if (ui && !opts.builtIn) return notFound(appPolicy)
    const csp = ui ? UI_CSP : appPolicy
    if (!opts.assets) return notFound(csp)
    const file = assetFile(path, ui ? UI_BUNDLE : APP_BUNDLE)
    if (!file) return notFound(csp)
    if (!read) return methodNotAllowed(csp)
    return withHeaders(await forward(file), csp)
  }
  const entry = PAGE_TABLE.find((p) => p.path === path)
  const authPage = entry?.bundle === UI_BUNDLE
  if (authPage && !opts.builtIn) return notFound(appPolicy)
  // Without the binding nothing under `/app` and not the root is served: 404 for any method.
  if (!opts.assets) return notFound(authPage ? UI_CSP : appPolicy)
  const redirects = isRoot || path === APP_PREFIX || path === `${APP_PREFIX}/`
  if (!entry && !redirects) return notFound(appPolicy)
  const csp = authPage ? UI_CSP : appPolicy
  if (!read) return methodNotAllowed(csp)
  if (redirects) return withHeaders(new Response(null, { status: 302, headers: { location: HOME } }), csp)
  return withHeaders(await forward(`${ASSET_PREFIX}/${entry!.bundle}/`), csp)
}
