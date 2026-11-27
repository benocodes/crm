---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

A task's free text is now `description` instead of `notes`, on every surface: the `tasks` table and its full-text index, the REST, MCP and CLI task commands and filters, `tasks aggregate --group-by`, the schema document, task events and webhook payloads. There is no `notes` alias: sending `notes` on a task is refused like any other unknown field. The notes resource is unchanged. There is no upgrade path: the change edits the genesis migration in place, so an existing instance is reinstalled, as for the genesis squash.
