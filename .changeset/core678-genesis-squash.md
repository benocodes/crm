---
'@vibase/server-d1': minor
---

The database migrations are squashed into one genesis file per database: `migrations/0001_genesis.sql` for the CRM database and `control-migrations/0001_genesis.sql` for the control database. They build the same schema the 31 CRM files and 5 control files did, so a new install is unchanged. An install made before this version cannot upgrade, because its `d1_migrations` holds the old file names and genesis would run `CREATE TABLE` over existing tables and fail without changing anything. Reinstall it instead: destroy the instance's databases and set it up again.
