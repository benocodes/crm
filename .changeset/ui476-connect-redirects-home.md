---
'@vibase/server-d1': minor
---

`/connect` redirects to `/home`: `GET` and `HEAD` of `/connect` and `/connect/` answer `302 Location: /home` (the query dropped), another method answers `405`, and nothing else under `/connect/` is served (`404 not_found`). The old connect page leaves the package: its bundle is no longer built or released (`dist/assets/connect/` and `assets/connect/` are gone), and the Agents page at `/agents` shows who is connected and lets an owner disable or enable an agent. Sign-in and sign-out return paths of the app's session seam are required; none defaults to `/connect`.
