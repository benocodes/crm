---
'@vibase/server-d1': patch
---

The control database follows the same schema conventions as the CRM database (canonical id and timestamp CHECKs everywhere, every CHECK named, `idx_<table>_<what>` index names, the unique (organization_id, id) index on webhook subscriptions), the declared text limits of contacts, companies and tasks are now database CHECKs (`contacts.name`, `companies.name`, `companies.domain`, `tasks.title`, `tasks.description`), and the tables and columns a schema file creates carry named CHECKs and a unique (organization_id, id) index. Capture, forms and contact merge already stay within the limits. No column's type, nullability, default or foreign key changes. There is no upgrade path: the change edits both genesis migrations in place, so an existing instance is reinstalled, as for the genesis squash.
