---
'@vibase/server-d1': minor
---

`vibase-server redeploy --env <name>` puts the installed package's build on an instance whatever is live: a new build of the same version, the same build again, or an older package as a rollback. It applies only the migrations the instance lacks, never reverses one, and refuses no version or schema. `upgrade` no longer calls a same-version, different build "nothing to do": it stops, naming both commits and `redeploy`, and `status` reports it too. `upgrade --rollback` is removed in favour of `redeploy`, and `upgrade` and `redeploy` now wait for the new commit on `/health`, not only the version.
