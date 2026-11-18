---
'@vibase/server-d1': minor
---

The Worker answers `POST /f/{public_id}` and its `OPTIONS` preflight: the public website-form endpoint. It needs no authentication and sits behind the migration, configuration, control and deployment-marker gates. A submission is checked against the form's allowed origins and a Cloudflare Turnstile token (`TURNSTILE_SECRET_KEY`, a Worker secret; without it the route answers `503 challenge_unavailable`), rate limited by the new `FORM_IP_LIMITER` (10 a minute per IP and form) and `FORM_LIMITER` (60 a minute per form) `ratelimits` bindings declared in `wrangler.jsonc` (skipped when a binding is absent; needs wrangler 4.36 or later), and captured as a `form` thread, message and interaction. The route is documented in the docs (Website forms) and is not in OpenAPI or MCP. The `channel` column descriptions now name `email` and `form`.
