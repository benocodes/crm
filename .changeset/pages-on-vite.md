---
'@vibase/server-d1': patch
---

The workspace app and the auth pages are now built by Vite instead of esbuild and the Tailwind CLI. The served files, paths and headers are unchanged (`app/{index.html,app.js,app.css}`, `ui/{index.html,app.js,ui.css}`); the bytes differ because the bundler and minifier differ. For development, `pnpm dev` also starts a hot-reloading Vite server on `http://localhost:5173` in front of the local Worker (`pnpm dev:worker` is the Worker alone), and `.dev.vars.example` names that origin in `AUTH_TRUSTED_ORIGINS` and `CLERK_AUTHORIZED_PARTIES`.
