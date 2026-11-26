---
'@vibase/server-d1': minor
---

A bearer app's origin in `CORS_ALLOWED_ORIGINS` (exact or a wildcard) can now call `/auth/oauth2/register` and `/auth/oauth2/token` with `fetch` and read every answer, with no cookie: the preflight is answered `204` (`POST`, `Content-Type`) and every answer carries the origin and `Vary: Origin`, never `Access-Control-Allow-Credentials`. No other `/auth` path changes, and an origin also in `AUTH_TRUSTED_ORIGINS` keeps its credentialed answer.
