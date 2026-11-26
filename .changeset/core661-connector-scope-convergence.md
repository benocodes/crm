---
'@vibase/server-d1': minor
---

A connector that registered itself before a scope existed (for example before a custom object was declared with `redeploy --schema`) can now authorise again with the same client: at `/oauth2/authorize` the stored scope list of a dynamically registered client is grown to include every scope a new registration may ask for, never removing one and never adding the wildcard or a human-only scope. The connector reaches the consent page asking for the new scope and keeps the same delegated agent; the new scope still needs the owner's grant on that agent's record. Clients created by an owner, first-party apps, disabled clients and the CLI client are left as they are.
