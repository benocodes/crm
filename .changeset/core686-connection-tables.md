---
'@vibase/server-d1': minor
---

The connection tables carry channel-neutral names: `channel_connections` is `connections`, `channel_credentials` is `connection_credentials`, `mail_sync_cursors` is `connection_sync_cursors` (its `history_id` column is `cursor`), `mail_sync_state` is `connection_sync_state` and `gmail_watches` is `connection_watches` (its `mailbox` column is `address`), with their constraints and indexes renamed to match. The schema document (`schema_get`) names `connections` as the foreign-key target wherever it named `channel_connections`. There is no upgrade path: the change edits the genesis migration in place, so an existing instance is reinstalled, as for the genesis squash.
