---
"@vibase/server-d1": patch
---

`setup:remote --replace-instance <env>` (checkout-only) builds a fresh Better Auth instance on the `vb-` names in place of a recorded one, leaving the old resources untouched. The shared refusal texts for a provider change and a rename now point at it; `vibase-server setup` does not take the flag.
