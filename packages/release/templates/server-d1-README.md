# @vibase/server-d1

A prebuilt vibase Worker for Cloudflare D1: the Worker bundle, the connect page, the D1 migrations and a base Worker config with no instance in it, plus `vibase-server`, the program that sets up, checks and upgrades an instance from them.

`release.json` lists the version, the source commit, the wrangler version this release was tested with and a sha256 of every file. The package installs that exact wrangler beside `vibase-server`; every command verifies the files against `release.json` before it touches the network.

```bash
npx @vibase/server-d1@<version> setup --env <name> --api-host <host> [--auth clerk|none] [--dry-run]
npx @vibase/server-d1@<version> status --env <name>
npx @vibase/server-d1@<version> upgrade --env <name> [--dry-run]
```

Or install it, then run `vibase-server <command>`. The package that runs is the version that deploys: upgrading a server is running a newer pinned version. Until the package is on the registry, use the release's tarball by file: `npx --package ./vibase-server-d1-<version>.tgz vibase-server <command>`.

The settings and secrets of an instance are files outside the package: `$XDG_CONFIG_HOME/vibase/instances/<env>.json` and `<env>.env` (mode 600, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`). Remote commands need `CONFIRM_REMOTE=1`; `--dry-run` reads only. `vibase-server --help` lists every flag.

The stable paths other tooling may rely on are the package's `exports`: `./worker`, `./wrangler.base.jsonc`, `./release.json`, `./migrations/*`, `./assets/*` and `./package.json`.

Node 22 or newer. Licence: AGPL-3.0-only.
