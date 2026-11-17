---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

`connections.update` (`PATCH /meta/v1/connections/{id}`, MCP tool `connections_update`, CLI `vibase connections update <id>`): the owner of a connection, signed in, changes its capture settings (labels, blocked senders, group-address and personal-domain exclusion, contact creation) in one call. A list replaces the whole list; every accepted call emits one `connection.updated`. The `connections:write` scope now reads "Connect and disconnect mailboxes, and change their capture settings".
