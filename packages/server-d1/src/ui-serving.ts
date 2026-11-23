// [[UI246]] D1, D2: the auth pages (`/sign-in`, `/invite`, `/reset-password`, `/consent`, `/device`) and the `/ui/` bundle on the API origin, from the Workers Static Assets binding, with the security headers on every
// response. The pages exist only for `AUTH_PROVIDER=better-auth` (the caller decides; for any other provider these paths are no route at all). Static: the answer reads no storage and needs no
// credential, so it runs before the migration, configuration and control gates (the pages' own API calls meet them).
import { PAGE_CSP } from '@vibase/ui/csp'
import { ASSET_PREFIX, UI_BUNDLE } from './app/paths.js'

export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

/** The five exact page paths ([[UI246]] D1, [[UI247]] D1 adds `/consent` and `/device`). A trailing slash or any longer path is not a page: it is the Worker's own `404 not_found`. */
export const UI_PAGE_PATHS = ['/sign-in', '/invite', '/reset-password', '/consent', '/device'] as const
/** Where the build puts the bundle, the stylesheet and the page's `index.html`: `/assets/ui/<file>` is the asset path ([[UI504]] D3). */
const UI_ASSET_PREFIX = `${ASSET_PREFIX}/${UI_BUNDLE}`
/** What `wrangler.jsonc`'s `assets.run_worker_first` lists for these pages, derived from the constants the Worker serves; the files are under `/assets/*` (`APP_RUN_WORKER_FIRST`), and `/ui/*` is no longer listed. */
export const UI_RUN_WORKER_FIRST: readonly string[] = [...UI_PAGE_PATHS]

/** D2's policy: no third-party script, no inline script or style (the stylesheet is `'self'`), same-origin API calls and forms only. One value with the React gallery's run ([[UI445]] D6). */
export const UI_CSP: string = PAGE_CSP

/** The page is the assets directory's `assets/ui/index.html`, which the binding serves at its directory path. It is reached only through the page paths. */
const INDEX_PATH = `${UI_ASSET_PREFIX}/`

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('content-security-policy', UI_CSP)
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  if ((out.headers.get('content-type') ?? '').startsWith('text/html')) out.headers.set('cache-control', 'no-store')
  return out
}

const isPagePath = (pathname: string): boolean => (UI_PAGE_PATHS as readonly string[]).includes(pathname)

/** True for a page path and for `/assets/ui` and anything under `/assets/ui/` (`/assets/uix` is not ours; `/ui/*` is no route of the static serving, [[UI504]] P2). */
export const isUiPath = (pathname: string): boolean =>
  isPagePath(pathname) || pathname === UI_ASSET_PREFIX || pathname.startsWith(`${UI_ASSET_PREFIX}/`)

const notFound = () =>
  withHeaders(
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
  )

/** The built file `/assets/ui/<file>` names; a folder path (`/assets/ui`, `/assets/ui/`, `/assets/ui/x/`) and `index.html` are none ([[UI504]] P1). */
const isUiFile = (pathname: string): boolean => {
  if (!pathname.startsWith(`${UI_ASSET_PREFIX}/`)) return false
  const rest = pathname.slice(UI_ASSET_PREFIX.length + 1)
  return rest !== '' && !rest.endsWith('/') && rest !== 'index.html'
}

/**
 * Answers a request for a page path or `/assets/ui`, or `undefined` for any other path. `GET`/`HEAD` of a page path is the one `index.html`; `/assets/ui/<file>` is the built file (or the binding's `404`); `/assets/ui`,
 * `/assets/ui/` and `/assets/ui/index.html` are not pages (the JSON `404`, any method, [[UI504]] P1). Another method on a page or a file is `405`. Without the binding every such path is `404`.
 */
export async function serveUi(req: Request, opts: { assets?: AssetsLike }): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (!isUiPath(url.pathname)) return undefined
  if (!isPagePath(url.pathname) && !isUiFile(url.pathname)) return notFound()
  // P1: without the binding every `/assets/` path is `404`, whatever the method.
  if (!opts.assets && !isPagePath(url.pathname)) return notFound()
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return withHeaders(
      new Response('method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
      }),
    )
  if (!opts.assets) return notFound()
  const target = new URL(isPagePath(url.pathname) ? INDEX_PATH : url.pathname, url.origin)
  return withHeaders(await opts.assets.fetch(new Request(target, { method: req.method, headers: req.headers })))
}
