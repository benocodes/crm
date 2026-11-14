---
"@vibase/server-d1": patch
---

Membership writes and owner-issued reset links on the built-in provider. Owners (new owner-held, human-only scope `members:write`) change a member's role (`memberships.update`, `vibase memberships update <id> --role member`) or remove a member (`memberships.delete`, a soft delete): removing or demoting the last owner is `409 last_owner`, decided in the write's own statement. A removed member is denied at once (roles are read per request); the vault then revokes that person's sessions, OAuth access and refresh tokens and pending device codes and records a `user.sessions_revoked` audit row. `users.issue_reset_link` (`vibase users issue-reset-link --user-id <id>`) returns a one-time password reset link for a member, valid for one hour and shown once, with a `user.reset_link_issued` audit row; the public `POST /auth/request-password-reset` stays refused while email is off. On Clerk and on Postgres these operations answer `501 provider_not_configured`.
