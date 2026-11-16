---
'@vibase/server-d1': patch
---

On the built-in sign-in provider, an OAuth authorize request that names no scope (absent, empty or blank) now asks for the default-grant set, the same list a registration naming no scope is given, instead of every scope the client may name. `audit:read` is no longer requested by default; a client that names it still gets the consent prompt for it.
