---
"@vibase/server-d1": patch
---

OAuth pages on the built-in provider. The Worker also serves `/device` and `/consent` (the same bundle, headers and `better-auth`-only gate as the other auth pages; `run_worker_first` gains both paths). `vibase login` now ends in the browser: `verification_uri_complete` is `<PUBLIC_BASE_URL>/device?user_code=…`, where a signed-in person checks the code, sees the app and its scopes and approves or denies. An MCP client's authorization request resumes through `/sign-in` (the signed query is forwarded) and stops at `/consent` (`consentPage` is now `/consent`), where the person allows or denies all requested scopes. The device code format is pinned to 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 30 minutes, polled every 5 seconds; `/sign-in?return_to=` is honoured for `/device` and `/connect` only. The connect page is unchanged.
