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

The stable paths other tooling may rely on are the package's `exports`: `./worker`, `./wrangler.base.jsonc`, `./release.json`, `./migrations/*`, `./control-migrations/*` (the control-plane database's migrations), `./assets/*` and `./package.json`.

## Turning on email

Email is off by default: invitation links are handed over by the owner. To have the Worker email invitations instead, an operator turns it on by hand (setup does not):

1. In the Cloudflare dashboard, onboard a sending domain for Email Service (the domain's DNS must be on Cloudflare; arbitrary recipients need the Workers Paid plan; the service is in beta).
2. Add a `send_email` binding named `EMAIL` to the Worker config (`"send_email": [{ "name": "EMAIL" }]`) and a variable `AUTH_EMAIL_FROM` holding a bare sender address on that domain (for example `invites@example.com`).
3. Deploy. Both must be present; one without the other, or a malformed address, makes every request except `/health` answer `500` and the log names the variable.

With email on, `invitations.create` sends the link to the invited address by default and does not return it (`delivery: "email"`); pass `delivery: "link"` to get the link back instead. A failed send revokes the invitation and answers `502 email_send_failed`. Accepting an emailed invitation records the address as verified. Email applies to the built-in provider (`AUTH_PROVIDER=better-auth`) only.

Node 22 or newer. Licence: AGPL-3.0-only.
