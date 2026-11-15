---
"@vibase/server-d1": patch
"@vibase/cli": patch
---

Read the control-plane audit log. `audit.list` (`GET /meta/v1/audit`, MCP tool `audit_list`, `vibase audit list`) browses `control_audit` (invitations created, revoked and accepted, sessions revoked on removal, reset links issued) oldest first, filtered by exact `action`, `target_type` and `target_id`, paged by `limit` (1 to 200, default 50) and `after`/`next_cursor`. New scope `audit:read`: held by every owner, never by a member, and an owner may grant it to an agent; it is not in any default grant (the bootstrap agent, Clerk's default scopes, the registration default list). A deployment without a control-plane database answers `501 provider_not_configured`. Reading writes nothing. Clerk instances gain the scope in their catalog when `setup:remote` is next run.
