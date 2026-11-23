---
'@vibase/server-d1': minor
---

The page bundles' static files moved: the app's script and stylesheet are served at `/assets/app/app.js` and `/assets/app/app.css`, and the auth pages' at `/assets/ui/app.js` and `/assets/ui/ui.css` (Better Auth instances only), nowhere else. The old paths (`/app/app.js`, `/ui/app.js`, and the stylesheets and `index.html` files beside them) answer `404`. The pages stay at their current paths and load their files from the new place. The release package holds the files under `assets/assets/<bundle>/`, and the Worker's `run_worker_first` list gains `/assets/*` and loses `/ui/*`: an instance deployed from an older checkout needs a redeploy (`vibase-server upgrade`) to serve the pages.
