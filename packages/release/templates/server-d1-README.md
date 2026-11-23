# @vibase/server-d1

A prebuilt vibase Worker for Cloudflare D1: the Worker bundle, the workspace app and auth pages, the D1 migrations and a base Worker config with no instance in it, plus `vibase-server`, the program that sets up, checks, upgrades and redeploys an instance from them.

`release.json` lists the version, the source commit, the wrangler version this release was tested with and a sha256 of every file. The package installs that exact wrangler beside `vibase-server`; every command verifies the files against `release.json` before it touches the network.

```bash
npx @vibase/server-d1@<version> init --env <name> --api-host <host> --owner-email <email>
npx @vibase/server-d1@<version> setup --env <name> [--dry-run]
npx @vibase/server-d1@<version> status --env <name>
npx @vibase/server-d1@<version> upgrade --env <name> [--dry-run]
npx @vibase/server-d1@<version> redeploy --env <name> [--dry-run]
```

Or install it, then run `vibase-server <command>`. The package that runs is the version that deploys: upgrading a server is running a newer pinned version (`upgrade` moves forward by version and stops, naming `redeploy`, when the instance runs the same version from a different build). `redeploy` puts this package's build on the instance whatever is live: a new build of the same version, the same build again, or an older package as a rollback. It refuses no version or schema, applies only the migrations the instance lacks and never reverses one, so a rollback runs older code on the newer schema (it prints one line saying so). Until the package is on the registry, use the release's tarball by file: `npx --package ./vibase-server-d1-<version>.tgz vibase-server <command>`.

The settings and secrets of an instance are files outside the package: `$XDG_CONFIG_HOME/vibase/instances/<env>.json` and `<env>.env` (mode 600, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`). A new instance starts with `vibase-server init --env <name>`, which writes the settings file (the API host, the auth provider and the owner email you gave it) and the secrets file (generated secrets and an empty line for each value you supply), and prints the command to run next: `setup --env <name>`, with no host, provider or owner flags to repeat (a flag that differs from the settings file is refused). Without init, a new instance's first `setup` takes `--api-host` (or `--workers-dev`) and `--owner-email`. `setup`, `upgrade`, `redeploy` and `owner-reset` print their plan and ask `proceed? [Y/n]` once before the first change; `--yes` (or no terminal) skips it, and `--dry-run` reads only. `vibase-server --help` lists every flag.

Setup verifies through the Cloudflare API (the Worker's build and variables, its secrets, the host, both databases, the bucket) and makes one short request to `/health`; a host that does not resolve yet is reported as `not reachable yet` and does not fail the run. It ends with the owner invitation, or why there is none.

The stable paths other tooling may rely on are the package's `exports`: `./worker`, `./wrangler.base.jsonc`, `./release.json`, `./migrations/*`, `./control-migrations/*` (the control-plane database's migrations), `./assets/*` and `./package.json`.

## Turning on email

Email is off by default: invitation links are handed over by the owner. To have the Worker email invitations instead, an operator turns it on by hand (setup does not):

1. In the Cloudflare dashboard, onboard a sending domain for Email Service (the domain's DNS must be on Cloudflare; arbitrary recipients need the Workers Paid plan; the service is in beta).
2. Add a `send_email` binding named `EMAIL` to the Worker config (`"send_email": [{ "name": "EMAIL" }]`) and a variable `AUTH_EMAIL_FROM` holding a bare sender address on that domain (for example `invites@example.com`).
3. Deploy. Both must be present; one without the other, or a malformed address, makes every request except `/health` answer `500` and the log names the variable.

With email on, `invitations.create` sends the link to the invited address by default and does not return it (`delivery: "email"`); pass `delivery: "link"` to get the link back instead. A failed send revokes the invitation and answers `502 email_send_failed` (if that revoke also fails the invitation stays pending until it expires or an owner revokes it). Accepting an emailed invitation records the address as verified.

Email also turns on self-service password reset: `/app/sign-in` then shows "Forgot password?", which asks `POST /auth/request-password-reset` for a link and emails it (valid one hour, answered the same for every address, at most 5 requests per hour per client IP; a completed reset signs the person out everywhere). Owner-issued reset links stay returned links and are never emailed. With email off, `/app/sign-in` keeps telling people to ask an owner and the request is refused. Email applies to the built-in provider (`AUTH_PROVIDER=better-auth`) only.

Node 22 or newer. Licence: AGPL-3.0-only.
