---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

A person's default `vibase login` on the built-in provider now asks for the wildcard `all_permissions` (named in discovery as `auth.full_access_scope`) instead of a snapshot of every scope, so the person holds their live role, including permissions declared after they signed in, on the same token. A `--scope` login stays limited to its list, `--scope all_permissions` is refused, an agent account that approves the wildcard gets its record at that moment and never the wildcard, a connector cannot ask for it, and the device page states full access in words. `agents.create` and `agents.update` now accept any custom scope the registry declares, whatever scopes the caller's own sign-in lists.
