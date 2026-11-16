---
'@vibase/server-d1': minor
---

New variable `AUTH_TRUSTED_ORIGINS` (a comma-separated list of first-party app origins, read only with `AUTH_PROVIDER=better-auth`). Each listed origin is trusted by Better Auth (cookie-bearing POSTs such as sign-out, and `callbackURL`), gets credentialed CORS on `/auth/*` only, and is a place `/sign-in?return_to=` can send a person back to after they sign in. `/api`, `/meta` and `/mcp` are unchanged: an app that also calls `/api` stays in `CORS_ALLOWED_ORIGINS`. Empty or unset changes nothing; a malformed value makes the Worker answer `500 internal`.
