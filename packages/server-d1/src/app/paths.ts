// [[UI460]] D1, D6: the workspace app's served paths. Dependency-free, so the Worker, the build, the config tests and the release tooling all read the one list.
/** The app's pages: exact paths, no trailing slash, nothing below them (UI443 D1; `/accounts` joined with UI467, `/agents` with UI459). Home is first: the root redirects to it. */
export const APP_PAGE_PATHS = ['/home', '/accounts', '/agents'] as const
/** The app's `/app` path prefix: claimed statically as the JSON 404 until the pages move under it (UI504 cycle 2). The built files are under `/assets/app/` (`ASSET_PREFIX`). */
export const APP_PREFIX = '/app'
/** [[UI504]] D3, P4: the static files of both bundles are at `/assets/<bundle>/<file>` and nowhere else. The one prefix every serving module, the build and the config list read. */
export const ASSET_PREFIX = '/assets'
/** The two bundles' directory names: under `src/`, under the built `assets/` and as the second URL segment (`/assets/app/…`, `/assets/ui/…`). */
export const APP_BUNDLE = 'app'
export const UI_BUNDLE = 'ui'
/** What `wrangler.jsonc`'s `assets.run_worker_first` lists for the app: the root (it redirects), the page paths, `/app` and its bundle prefix (the Worker's 404, so the binding never answers there) and the static files (`/assets/*`), derived from the constants the Worker serves. */
export const APP_RUN_WORKER_FIRST: readonly string[] = [
  '/',
  ...APP_PAGE_PATHS,
  APP_PREFIX,
  `${APP_PREFIX}/*`,
  `${ASSET_PREFIX}/*`,
]
