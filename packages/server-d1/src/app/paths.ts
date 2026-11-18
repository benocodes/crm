// [[UI460]] D1, D6: the workspace app's served paths. Dependency-free, so the Worker, the build, the config tests and the release tooling all read the one list.
/** The app's pages: exact paths, no trailing slash, nothing below them (UI443 D1; `/agents` joins with its page, `/accounts` joined with UI467). Home is first: the root redirects to it. */
export const APP_PAGE_PATHS = ['/home', '/accounts'] as const
/** Where the build puts `index.html`, `app.js` and `app.css`: `/app/<file>` is the asset path. */
export const APP_PREFIX = '/app'
/** What `wrangler.jsonc`'s `assets.run_worker_first` lists for the app: the root (it redirects), the page paths, `/app` itself (the Worker's 404, so the assets binding never answers the directory path) and the bundle, derived from the constants the Worker serves. */
export const APP_RUN_WORKER_FIRST: readonly string[] = ['/', ...APP_PAGE_PATHS, APP_PREFIX, `${APP_PREFIX}/*`]
