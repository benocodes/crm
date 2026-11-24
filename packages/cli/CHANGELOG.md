# @vibase/cli

## 0.2.1

### Patch Changes

- 0dfefd6: The published README is now the repository's root README: what Vibase is, install, a short quickstart and a link to https://docs.vibase.ai. The `@vibase/server-d1` README links to the documentation too.

## 0.2.0

### Minor Changes

- 0f29f3c: `connections.update` (`PATCH /meta/v1/connections/{id}`, MCP tool `connections_update`, CLI `vibase connections update <id>`): the owner of a connection, signed in, changes its capture settings (labels, blocked senders, group-address and personal-domain exclusion, contact creation) in one call. A list replaces the whole list; every accepted call emits one `connection.updated`. The `connections:write` scope now reads "Connect and disconnect mailboxes, and change their capture settings".
- 8cb1cea: The workspace blocklist, `blocked_senders` (REST `/meta/v1/blocked-senders`, MCP tools `blocked_senders_*`, CLI `vibase blocked-senders list|get|create|delete`): an owner, signed in, blocks addresses and domains for every mailbox of the workspace and lifts them again; anyone holding the new `blocked_senders:read` scope reads the list. `blocked_senders:write` is owner-only and not agent-grantable; the list is not proposable. Every change emits `blocked_sender.created` or `blocked_sender.deleted`. Capture does not apply the list yet.

### Patch Changes

- c2747c0: Read the control-plane audit log. `audit.list` (`GET /meta/v1/audit`, MCP tool `audit_list`, `vibase audit list`) browses `control_audit` (invitations created, revoked and accepted, sessions revoked on removal, reset links issued) oldest first, filtered by exact `action`, `target_type` and `target_id`, paged by `limit` (1 to 200, default 50) and `after`/`next_cursor`. New scope `audit:read`: held by every owner, never by a member, and an owner may grant it to an agent; it is not in any default grant (the bootstrap agent, Clerk's default scopes, the registration default list). A deployment without a control-plane database answers `501 provider_not_configured`. Reading writes nothing. Clerk instances gain the scope in their catalog when `setup:remote` is next run.
