---
'@vibase/server-d1': minor
---

`vibase-server init` also writes the instance's settings file (`<env>.json`, marked `stage: "init"`) with the API host, the auth provider and the owner email, and prints `vibase-server setup --env <env>` (plus `--secrets-file` when given) as the next command. `vibase-server setup` takes the host, provider and owner email from that file, or from an instance's record, when the flags leave them out, and refuses a flag that differs; `--api-host` or `--workers-dev` is optional for a recorded instance. `config:write` adopts init's file as the full record, which now also keeps `owner_email`. `status`, `upgrade`, `redeploy` and `owner-reset` refuse an init-written file with "not set up yet". Re-running `init` replaces its own settings file until setup has run once.
