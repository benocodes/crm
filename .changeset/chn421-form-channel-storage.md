---
'@vibase/server-d1': minor
---

Migration `0024_form_channel.sql`: the capture tables accept channel `form` and a form is a message or thread source (`threads`, `messages`, `interactions`, `message_sources` and `thread_sources` are rebuilt; every row is kept). The `channel` filter of `threads`, `messages` and `interactions` lists now accepts `form` (empty until the public form route ships). No behaviour change for Gmail capture; apply the migration with `vibase-server upgrade` or `db:migrate:remote`.
