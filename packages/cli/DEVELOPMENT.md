# @vibase/cli: `vibase`

Vibase on the command line ([[API6]] cycle 1). Every operation of the instance it talks to becomes a command, discovered at run time
from `<server>/.well-known/vibase` and the two OpenAPI documents it names. No runtime dependencies, Node 22.4 or later.

From the repo root, `pnpm vibase <args>` runs the built CLI (it builds `dist/vibase.js` first if it is missing) in the directory you
typed the command in, so relative `@file` and `--output` paths resolve against your directory, not the repo root. The same CLI runs as
`node packages/cli/dist/vibase.js <args>`, or as a bare `vibase` on your PATH: `pnpm -C packages/cli build`, then `pnpm link --global`
from `packages/cli` (the package declares `bin: vibase`). The examples below write `vibase` for whichever you use.

```bash
pnpm vibase --help                               # from the repo root; builds packages/cli/dist/vibase.js on first use
pnpm -C packages/cli build                       # writes dist/vibase.js (rebuild after changing the CLI)
node packages/cli/dist/vibase.js --help

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

## Sign in by device login

An instance with a sign-in configured (`auth` in `<server>/.well-known/vibase`) is signed in to from any browser, on any machine:

```bash
vibase login --server https://api.example.com               # prints a URL and a code on stderr; approve in a browser
vibase login --server https://api.example.com --scope contacts:read,contacts:write   # ask for less
vibase --profile work login --server https://api.example.com   # a second identity in its own profile
vibase me get                                               # who am I; login already printed it on stdout
vibase logout                                               # revokes the refresh token, then forgets the profile
```

The CLI never opens a browser: it prints `verification_uri_complete` (or the URL and the user code) and the expiry on stderr, then polls.
Stdout stays machine-readable (the `me` document). By default it asks for every scope the instance supports plus `offline_access`; the
Vibase caps the token at what the person or agent account may do, so asking for all loses nothing. The profile (kind `oauth`) is stored in
the same `config.json`. A login that is denied, expires or fails leaves the profile as it was.

The access token is refreshed when it is within 60 s of expiry and once when the server answers `401`; parallel `vibase` processes
share one refresh through a lock file beside the config (`config.json.lock`). If the grant is gone (`invalid_grant`) the tokens are
cleared and the command exits `1` telling you to run `vibase login` again. `logout` revokes the refresh token (RFC 7009); if that
fails it still removes the profile, says so on stderr and exits `1`. An access token already issued stays valid until it expires.

The access token goes only to `--server`'s origin; the refresh token only to the issuer's token and revocation endpoints. The issuer and
its endpoints must be `https`, and a redirect from any of them is an error.

## Onboard an agent account

An agent that is not a person (a sales agent, an automation) signs in as its own Clerk user, so it has its own audit identity and its
scopes are set by an owner:

1. Invite the agent's email in Clerk with the public metadata `{ "vibase_role": "agent" }`.
2. As the agent (its own browser session, or yours with the agent's account): `vibase --profile agent login --server <url>`.
   It prints `me` with `kind: agent` and no scopes, and says on stderr that an owner must grant them.
3. An owner grants scopes with the id that login printed: `vibase agents update <agent-id> --data '{"scopes":["contacts:read","contacts:write"]}'`.
4. The agent's next request carries the grant (the token's scopes intersect with it). Disabling the agent (`agents update --data '{"disabled":true}'`)
   is the switch that stops it at once; its access tokens otherwise live until they expire.
5. To change one grant later, send the change, not the whole list:
   `vibase agents update <agent-id> --add-scopes '["messages:request_approval"]' --remove-scopes '["messages:write"]'`.
   The server merges it into the stored list; `--scopes` still replaces the list and cannot be combined with the deltas.
   Removing a scope the agent lacks changes nothing; a concurrent change to the same agent answers `409 conflict` (retry).

Not here yet: `events tail` (#105).
