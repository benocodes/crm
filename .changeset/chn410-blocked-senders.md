---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

The workspace blocklist, `blocked_senders` (REST `/meta/v1/blocked-senders`, MCP tools `blocked_senders_*`, CLI `vibase blocked-senders list|get|create|delete`): an owner, signed in, blocks addresses and domains for every mailbox of the workspace and lifts them again; anyone holding the new `blocked_senders:read` scope reads the list. `blocked_senders:write` is owner-only and not agent-grantable; the list is not proposable. Every change emits `blocked_sender.created` or `blocked_sender.deleted`. Capture does not apply the list yet.
