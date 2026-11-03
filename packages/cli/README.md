# @vault/cli: `vibase`

The vault on the command line ([[API6]] cycle 1). Every operation of the instance it talks to becomes a command, discovered at run time
from `<server>/.well-known/vibase` and the two OpenAPI documents it names. No runtime dependencies, Node 22.4 or later.

```bash
pnpm -C packages/cli build                       # writes dist/vibase.js
node packages/cli/dist/vibase.js --help          # or: pnpm vibase --help from the repo root

printf '%s' "$KEY" | vibase login --api-key --server https://api.example.com   # the key is read from stdin, never argv
vibase me get
vibase contacts create --name "Ada"              # body properties are flags (--due-at for due_at); --data <json|@file|-> gives the whole body
vibase contacts get <id>
vibase contacts list --all --limit 100           # NDJSON, one record per line
vibase files content <id> --output ./file.bin    # binary operations stream; a terminal needs --output
vibase logout
```

Output is JSON on stdout (indented on a terminal), errors are `{ "error": { "code", "message" } }` on stderr; exit `0` success, `1` the API or the
network failed, `2` usage or configuration. Settings: flags, then `VIBASE_SERVER` / `VIBASE_API_KEY` / `VIBASE_PROFILE`, then the profile in
`$XDG_CONFIG_HOME/vibase/config.json` (mode 0600). The command list is cached for an hour in `$XDG_CACHE_HOME/vibase/` (`--refresh` refetches).
Put the command words first: `vibase contacts list --limit 5`.

Not here yet: device login (#104), `events tail` (#105).
