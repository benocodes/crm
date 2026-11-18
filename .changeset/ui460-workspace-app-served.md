---
'@vibase/server-d1': minor
---

The workspace app is served. `GET /home` on any instance (Clerk, Better Auth or no provider) answers the app: a shell with a Home page ("Welcome to your CRM" and who you are: name, email, role and workspace), on the same session `/connect` uses. `GET /` redirects to `/home`. The release package gains `assets/app/` (`index.html`, `app.js`, `app.css`) and `wrangler.base.jsonc`'s `assets.run_worker_first` gains `/`, `/home`, `/app` and `/app/*`, so an instance upgrade needs the new base config. The app and `/connect` are served under one Content-Security-Policy that allows runtime `<style>` elements (`style-src 'self' 'unsafe-inline'`; `script-src` is unchanged), so `/connect`'s policy changes on Better Auth and with no provider; the sign-in, consent and device pages keep their stricter policy. Signing in from the app on Better Auth still lands on `/connect` until the sign-in returns ship.
