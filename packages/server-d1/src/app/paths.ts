// [[UI460]] D1, D6: the workspace app's served paths. Dependency-free, so the Worker, the build, the config tests and the release tooling all read the one list.
/** The app's `/app` path prefix: the pages are `/app/<page>`, `/app` and `/app/` redirect to Home, everything else under it is the JSON 404 (UI507 P4). The built files are under `/assets/app/` (`ASSET_PREFIX`). */
export const APP_PREFIX = '/app'
/** The two bundles' directory names: under `src/`, under the built `assets/` and as the second URL segment (`/assets/app/…`, `/assets/ui/…`). */
export const APP_BUNDLE = 'app'
export const UI_BUNDLE = 'ui'
/**
 * [[UI507]] D1, P2: the page table. Each page is an exact path under `/app` (no trailing slash, nothing below it) with the bundle that serves it. Home is first: `/`, `/app` and `/app/` redirect to it.
 * The auth bundle's five pages join the table in #510 (UI504 cycle 3); until then `UI_PAGE_PATHS` (`src/ui-serving.ts`) lists them.
 */
export const PAGE_TABLE: readonly { readonly path: string; readonly bundle: typeof APP_BUNDLE | typeof UI_BUNDLE }[] = [
  { path: '/app/home', bundle: APP_BUNDLE },
  { path: '/app/accounts', bundle: APP_BUNDLE },
  { path: '/app/agents', bundle: APP_BUNDLE },
]
/** The app bundle's page paths, read from the table (one list: the Worker, the dev server and the sign-in allow-list read this). */
export const APP_PAGE_PATHS: readonly string[] = PAGE_TABLE.filter((p) => p.bundle === APP_BUNDLE).map((p) => p.path)
/** [[UI504]] D3, P4: the static files of both bundles are at `/assets/<bundle>/<file>` and nowhere else. The one prefix every serving module, the build and the config list read. */
export const ASSET_PREFIX = '/assets'
/** What `wrangler.jsonc`'s `assets.run_worker_first` lists for the app: the root and `/app` (they redirect), everything under `/app/` (the pages and the Worker's 404 for the rest, so the binding never answers there) and the static files (`/assets/*`), derived from the constants the Worker serves. */
export const APP_RUN_WORKER_FIRST: readonly string[] = ['/', APP_PREFIX, `${APP_PREFIX}/*`, `${ASSET_PREFIX}/*`]
