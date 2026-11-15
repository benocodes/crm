---
"@vibase/server-d1": patch
---

Setup on Better Auth verifies the issuer and ends with the owner's next steps. Both `vibase-server setup` and `setup:remote` now check, after `/health`, that `/.well-known/vibase` reports `better-auth` with the issuer `<PUBLIC_BASE_URL>/auth` and that `/.well-known/oauth-authorization-server/auth` names the same issuer (a 5xx or no answer is retried inside the 300 s bound; a wrong answer fails at once). The closing output lists the owner claim line (only in the run that issued the invitation), `vibase login --server <url>`, the MCP URL, the Google redirect URI to add when Google is on, and the no-email statement. The install docs describe Better Auth as the default path and Clerk as an optional section.
