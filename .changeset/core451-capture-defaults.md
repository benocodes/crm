---
'@vibase/server-d1': minor
---

Migration `0025_capture_defaults.sql`: a new Gmail connection defaults to `contact_creation: sent` with `exclude_group_addresses` and `exclude_personal_domains` on (`channel_connections` is rebuilt for the new column defaults; every existing connection keeps its settings). Previously new connections created a contact for every correspondent and excluded nothing. Change an existing connection with `vibase connections update <id> --contact-creation sent --exclude-group-addresses --exclude-personal-domains`. Apply the migration with `vibase-server upgrade` or `db:migrate:remote`.
