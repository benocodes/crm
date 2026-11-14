---
"@vibase/server-d1": patch
---

Invitation-gated sign-up on the built-in provider. `POST /auth/sign-up/email` creates an account only when its body carries `invitation_token` for a live invitation of that email; every other attempt is `403 invitation_required`. Signing up accepts the invitation: the vault writes the user (or, for an agent invitation, an agent account with no scopes) and the membership with their events, then the invitation is marked accepted with an `invitation.accepted` audit row. An account left without its vault rows is repaired on its next sign-in while the invitation that admitted it is still live. Invitation links from `bootstrap --owner-email` and `invitations.create` now work.
