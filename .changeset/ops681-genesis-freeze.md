---
'@vibase/server-d1': patch
---

The database schema is now frozen at this release: both `0001_genesis.sql` files (CRM and control) never change again, and every later schema change ships as a new numbered migration. Installs from this version upgrade forward with `vibase-server upgrade`. Installs from before it (a `0.2.x` build or any earlier `main`) have a different genesis and are reinstalled.
