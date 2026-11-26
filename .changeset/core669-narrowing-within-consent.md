---
'@vibase/server-d1': minor
---

`agents update` on a connector (a delegated agent) can now narrow its scopes only within what the person approved when it signed in: a scope outside the consent answers `409 scope_not_consented` and writes nothing. Any change to a connector's scope list, an add back or a removal, now answers one `sign_in_notice` saying a later sign-in with a different list replaces it and pointing to an agent account for a hard limit. The agents guide and the Clerk page say so.
