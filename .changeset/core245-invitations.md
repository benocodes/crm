---
"@vibase/server-d1": patch
---

Invitations in the control plane. Control migration `0002` adds `invitations` and the append-only `control_audit` to the control database. Owners create, list and revoke invitations (`invitations.create|list|revoke`, owner-held human-only scopes `invitations:read|write`; the link is shown once and only its SHA-256 is stored). `bootstrap --auth-provider better-auth --owner-email <email>` issues the first owner invitation and prints its URL once; a re-run with no owner replaces it. The links are inert until invitation-gated sign-up lands.
