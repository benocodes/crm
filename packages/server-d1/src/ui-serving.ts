// [[UI246]] D1, D2: the auth pages (`/sign-in`, `/invite`, `/reset-password`) and the `/ui/` bundle on the API origin, from the Workers Static Assets binding, with the security headers on every
// response. The pages exist only for `AUTH_PROVIDER=better-auth` (the caller decides; for any other provider these paths are no route at all). Static: the answer reads no storage and needs no
// credential, so it runs before the migration, configuration and control gates (the pages' own API calls meet them).
export interface AssetsLike {
  fetch(req: Request): Promise<Response>
}

/** The three exact page paths ([[UI246]] D1). A trailing slash or any longer path is not a page: it is the Worker's own `404 not_found`. */
export const UI_PAGE_PATHS = ['/sign-in', '/invite', '/reset-password'] as const
/** Where the build puts the bundle, the stylesheet and the page's `index.html`: `/ui/<file>` is the asset path. */
export const UI_PREFIX = '/ui'
/** What `wrangler.jsonc`'s `assets.run_worker_first` lists for these pages, derived from the constants the Worker serves. */
export const UI_RUN_WORKER_FIRST: readonly string[] = [...UI_PAGE_PATHS, `${UI_PREFIX}/*`]

/** D2's policy: no third-party script, no inline script or style (the stylesheet is `'self'`), same-origin API calls and forms only. */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** The page is the assets directory's `ui/index.html`, which the binding serves at its directory path. It is reached only through the three page paths. */
const INDEX_PATH = `${UI_PREFIX}/`

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('content-security-policy', UI_CSP)
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  if ((out.headers.get('content-type') ?? '').startsWith('text/html')) out.headers.set('cache-control', 'no-store')
  return out
}

const isPagePath = (pathname: string): boolean => (UI_PAGE_PATHS as readonly string[]).includes(pathname)

/** True for a page path and for anything under `/ui/` (`/uix` and `/ui` itself are not ours). */
export const isUiPath = (pathname: string): boolean => isPagePath(pathname) || pathname.startsWith(`${UI_PREFIX}/`)

const notFound = () => withHeaders(new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }))

/**
 * Answers a request for a page path or under `/ui/`, or `undefined` for any other path. `GET`/`HEAD` of a page path is the one `index.html`; `/ui/<file>` is the built asset (or the binding's
 * `404`); `/ui/` and `/ui/index.html` are not pages (`404`). Another method is `405`. Without the binding every such path is `404`.
 */
export async function serveUi(req: Request, opts: { assets?: AssetsLike }): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (!isUiPath(url.pathname)) return undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') return withHeaders(new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } }))
  if (!opts.assets) return notFound()
  if (!isPagePath(url.pathname) && (url.pathname === INDEX_PATH || url.pathname === `${UI_PREFIX}/index.html`)) return notFound()
  const target = new URL(isPagePath(url.pathname) ? INDEX_PATH : url.pathname, url.origin)
  return withHeaders(await opts.assets.fetch(new Request(target, { method: req.method, headers: req.headers })))
}
