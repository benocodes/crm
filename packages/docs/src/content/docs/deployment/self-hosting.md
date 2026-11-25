---
title: Run an instance
description: Set up, check and upgrade a Vibase instance in your own Cloudflare account with the vibase-server program, with built-in Better Auth sign-in.
---

Each Vibase workspace runs in its owner's Cloudflare account. The backend is a Worker and one D1 database, with R2 for raw message bodies and files. Sign-in, OAuth consent and CLI device login are built in (Better Auth), so a new instance needs no account beyond Cloudflare. Clerk stays available as an [optional alternative](#use-clerk-instead).

This page is for the person who runs the instance. If an instance already exists and you only want to use it, see [using Vibase](/getting-started/quickstart/). Running an instance needs no checkout of the repository: the release's server package, `@vibase/server-d1`, carries the Worker, the workspace app, the database migrations and the `vibase-server` program that sets up, checks and upgrades an instance. Developers who work from a clone have [a source path](#from-source) at the end of this page.

## Prepare your accounts

You need:

- Node.js 22.12 or later.
- A Cloudflare account and an API hostname on a zone in that account, such as `api.example.com`. Setup does not create DNS records by hand: Cloudflare creates the custom domain's record itself.
- An email address for the workspace's first owner.
- Optional: a Google OAuth client, if members should sign in with Google (see [Sign in with Google](#sign-in-with-google-optional)).

One password hash may exceed the Workers Free plan's 10 ms CPU limit; Workers Paid is the safe plan for password sign-in until it is measured on Cloudflare.

## Get the server package

Versions are listed on the repository's Releases page; each release carries both tarballs and a `SHA256SUMS` file. Every command below pins the version it runs, and the package that runs is the version that deploys. The examples use the literal `<version>`; replace it with a version from that page.

```bash
npx @vibase/server-d1@<version> status --env mycompany
```

Until the packages are on npm, download the release's tarballs and check them against `SHA256SUMS` first (`sha256sum -c SHA256SUMS`, or `shasum -a 256 -c SHA256SUMS` on macOS), then run the program from the file:

```bash
npx --package ./vibase-server-d1-<version>.tgz vibase-server status --env mycompany
```

You can also install the package and run `vibase-server <command>` directly. `vibase-server --help` lists every command and flag.

## Create the settings and secrets files

An instance's two files live outside the package, so upgrading never touches them:

- Settings: `$XDG_CONFIG_HOME/vibase/instances/<env>.json` (`~/.config` when unset). `setup` writes it.
- Secrets: `<env>.env` beside it, mode 600, dotenv format. The program refuses a file that other users can read.

Let `vibase-server init --env <name>` write the instance's two files, the settings file and the secrets file. It asks for the instance name, its API host, the owner email and the auth and email providers (each has a flag, and with no terminal the flags are all it has), then creates the secrets file with mode 600 (it never overwrites one) and the settings file:

```bash
npx @vibase/server-d1@<version> init --env mycompany --api-host api.example.com --owner-email you@example.com
```

The file holds the generated secrets (`AUTH_SECRET`, and `CREDENTIALS_KEY` and `OAUTH_STATE_SECRET` for Gmail) and an empty line for each value only you can supply, each under a comment saying where it comes from. Init never prints a generated value. The settings file records what you told it (the API host, the auth provider and the owner email), marked as init's: setup reads those choices, so you do not repeat them as flags. Fill in the Cloudflare pair, at least:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
```

Gmail and Google sign-in stay off until you paste their Google client values into the file and re-run setup; setup says so, and which values turn them on, instead of refusing. Back up `CREDENTIALS_KEY`: losing it makes connected mailboxes unreadable. Init ends by printing the command to run next: `setup --env <name>` (plus the secrets file's path, only if you gave init one), which prints its plan and asks `proceed? [Y/n]` before changing anything. Running init again replaces its own settings file, until setup has run once; after that init refuses, because the instance's secrets must not be regenerated.

A file you wrote by hand works too: setup generates a missing `AUTH_SECRET` (the key that signs sessions), appends it to the file before it puts it on the Worker, and never prints it. Keep the file: a re-run reads the secret from it.

The Cloudflare token needs these permissions:

| Scope | Permissions |
| --- | --- |
| Account | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers Tail Read, Account Settings Read |
| The API hostname's zone | Zone Read, Workers Routes Edit |

To keep the files elsewhere, name them on every command:

```bash
npx @vibase/server-d1@<version> status --env mycompany --settings ./mycompany.json --secrets-file ./mycompany.env
```

`setup`, `upgrade`, `redeploy` and `owner-reset` print their plan and ask `proceed? [Y/n]` once, before the first change; Enter or `y` goes on and `n` stops with nothing changed. `--yes` (`-y`) skips the question, and so does a run with no terminal on stdin (a script, CI). `--dry-run` reads only and never asks.

## Set up with Better Auth

Run the read-only setup plan first. A dry run reads configuration and the Cloudflare account, and changes nothing. After init, `setup --env mycompany` is the whole command: the host, the provider and the owner email come from the settings file, and a flag that differs from them is refused. Without init (a settings file you wrote by hand, or none), give `--api-host` (or `--workers-dev`) and `--owner-email` on the first run, as below:

```bash
npx @vibase/server-d1@<version> setup --env mycompany --api-host api.example.com --owner-email owner@example.com --dry-run
```

Until the packages are on npm, run the same command from the release tarball:

```bash
npx --package ./vibase-server-d1-<version>.tgz vibase-server setup --env mycompany --api-host api.example.com --owner-email owner@example.com --dry-run
```

Then run the same command without `--dry-run`:

```bash
npx @vibase/server-d1@<version> setup --env mycompany --api-host api.example.com --owner-email owner@example.com
```

Or from the tarball, until the packages are on npm:

```bash
npx --package ./vibase-server-d1-<version>.tgz vibase-server setup --env mycompany --api-host api.example.com --owner-email owner@example.com
```

Setup creates or adopts the Cloudflare resources, writes the settings file, generates `AUTH_SECRET`, migrates both databases, bootstraps the deployment (the organisation, the `vibase-cli` client and the owner invitation), deploys the Worker, puts its secrets and verifies it. It stops at the first failed step and names it; rerun the same command after correcting the problem. Existing matching configuration is retained.

A new instance's resources are named `vb-<env>` (Worker), `vb-crm-<env>` (D1), `vb-control-<env>` (the control-plane D1 database, which holds the sign-in data) and `vb-bodies-<env>` (R2). Setup creates the control database for every instance, migrates it before the CRM database, and pairs the two with a marker written after the CRM deployment row. A rerun takes the names recorded in the settings file and refuses a name flag that differs from them; an instance recorded without a control database gets one added on its next run.

### Claim the instance

Setup prints the **owner invitation link** once, as the last lines of its output (after verify). It is shown once and stored nowhere: copy it when it appears. Open it in a browser to create the owner account. Setup never prints it again: a rerun reads the instance first, and if an owner or a pending invitation exists it issues nothing and prints no link.

Verify asks the Cloudflare API, not your host, whether the resources are in place: the Worker at this release's build with the recorded variables, its secrets (by name), the custom domain or workers.dev subdomain, both databases migrated and the bucket. The first failed check fails verify and names what it found. Verify then makes one request to `https://<your host>/health` (10 seconds, no retry, no waiting). If the host does not answer yet (a new custom domain can take a few minutes to resolve), verify still succeeds, says `not reachable yet` and skips the discovery checks; setup then ends with a note about DNS propagation. If the host answers, `/.well-known/vibase` must report `better-auth` with the issuer `https://<your host>/auth`, and `/.well-known/oauth-authorization-server/auth` must name the same issuer; each is read once, and a wrong or failing answer fails verify. Setup ends with the next steps: sign in from the CLI with `vibase login --server https://<your host>`, point MCP clients at `https://<your host>/mcp`, and see below for Google and email. When no invitation was issued in this run (an owner exists, or an invitation is pending) the last lines say so and name `vibase-server owner-reset`.

You can check the deployment yourself:

```bash
curl https://api.example.com/health
curl https://api.example.com/.well-known/vibase
```

Health should report an initialized instance with current migrations. Discovery should report `better-auth` authentication. Then [sign in with the CLI](/getting-started/quickstart/).

### Sign in with Google (optional)

Google sign-in is off until the Worker has a Google OAuth client. Put both `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` in the secrets file before you run setup (both or neither: setup refuses half a pair), and setup puts them on the Worker. When Google is on, the closing output lists one manual item that no program can do for you: add the redirect URI `https://<your host>/auth/callback/google` to that Google OAuth client. Google accepts the sign-in only after you do. A Google account joins the workspace only through an invitation sent to its verified email.

### Email is off by default

Email is not configured by setup. The statement setup prints, and which holds until you add an email sender yourself:

> Email is not configured: there is no self-service password reset. A member who forgets their password gets a reset link from an owner; an owner gets one from `vibase-server owner-reset` (needs this instance's Cloudflare credentials). Invitation links are printed for you to send.

### Recover the owner (owner-reset)

An owner who forgets their password has no self-service reset while email is off. Anyone holding the instance's Cloudflare credentials can issue one with `vibase-server owner-reset --env <name>` (the commands below run it through `npx`):

```bash
npx @vibase/server-d1@<version> owner-reset --env mycompany --dry-run
npx @vibase/server-d1@<version> owner-reset --env mycompany
npx @vibase/server-d1@<version> owner-reset --env mycompany --email owner@example.com
```

With one Better Auth owner, it prints a one-time reset link for them. With several, pass `--email` to name one; without it the command refuses and lists them. The link is a Better Auth reset link on your own host (`https://<your host>/app/reset-password#token=...`), valid for one hour; opening it sets a new password and signs that owner out everywhere. It is printed once and stored nowhere, and the audit log records that a link was issued (when, by the system, never the link). A second run prints a new link. `--dry-run` reads only: it names the owner (or the invitation) it would use and prints no link.

If the instance has no owner at all, `owner-reset --email <address>` issues an owner invitation for that address instead and replaces any live owner invitation, printed once the same way. An instance whose owners sign in through another provider is refused: recover those through that provider.

The command composes Better Auth on your machine with the instance's `AUTH_SECRET`, so keep the secrets file that setup wrote (`<env>.env`, mode 600): without `AUTH_SECRET` in it the command refuses, and a new value would sign everyone out. If the Worker has one and your file does not, copy it in.

## No domain: use workers.dev

Without a domain of your own, give `--workers-dev` instead of `--api-host`. The instance then lives on `<worker>.<subdomain>.workers.dev` (for `--env mycompany`, the Worker is `vb-mycompany`), and setup derives that host from your Cloudflare account's workers.dev subdomain. It works with Better Auth (the default) and with `--auth none`; it is refused with `--auth clerk`, which needs a custom domain.

```bash
npx @vibase/server-d1@<version> setup --env mycompany --workers-dev --owner-email owner@example.com --dry-run
```

```bash
npx @vibase/server-d1@<version> setup --env mycompany --workers-dev --owner-email owner@example.com
```

The account needs a workers.dev subdomain. If it has none, setup refuses and tells you where to register one (Cloudflare dashboard, Workers & Pages). Registering is an account-wide, one-time step that only you take: either in the dashboard, or by passing `--register-workers-subdomain <name>` once. Setup never registers one without that flag, never on a `--dry-run`, and never renames an existing subdomain.

```bash
npx @vibase/server-d1@<version> setup --env mycompany --workers-dev --register-workers-subdomain mycompany --owner-email owner@example.com
```

Everything else is as in the section above: the same steps, the same owner invitation printed once, the same verify, now on the workers.dev host. The API token needs `Workers Scripts Read` to read the subdomain, and `Workers Scripts Edit` to register it; no zone permission is needed.

## Moving to a custom domain

A workers.dev instance moves to a domain of your own with a re-run that names the new host and acknowledges what the move breaks:

```bash
npx @vibase/server-d1@<version> setup --env mycompany --api-host api.example.com --change-host
```

Without `--change-host`, a host that differs from the instance's record is refused. With it, setup checks that the new host is on a zone in your account, keeps `workers_dev` on, adds the custom-domain route, rewrites the recorded host and `PUBLIC_BASE_URL`, deploys and verifies on the new host. The same flag moves an instance between two custom domains (the old route is replaced; setup makes no DNS or custom-domain delete call, so detach the old custom domain in the dashboard if it stays attached).

The issuer is the base URL, so a move signs everyone out: every session and token is refused on the new host. After it, people sign in again, run `vibase login` again on each machine, reconnect MCP clients to the new URL, and, when Google sign-in is on, add the new Google redirect URI (`https://<new host>/auth/callback/google`) to the Google OAuth client. There is no grace period for the old issuer. Moving from a custom domain back to workers.dev, and `--change-host` on a Clerk instance, are not offered. A re-run after the move with `--api-host <new host>` alone is a plain re-run.

## Use Clerk instead

Clerk is an optional alternative to the built-in sign-in. Every setup command in this section carries `--auth clerk`; without it a new instance uses Better Auth. An instance keeps the provider it was set up with: changing it later is a migration, not a setup rerun.

You also need a Clerk application dedicated to this workspace. A development instance works for an evaluation; use a production instance for your deployed business workspace. Create the secrets file with the Clerk application's keys as well:

```dotenv
CLERK_SECRET_KEY=your_clerk_secret_key
CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
```

Copy both keys from the same Clerk instance; setup derives the issuer and the JWT verification key. Clerk's setup uses Clerk, not Better Auth, for sign-in, OAuth consent and CLI device login.

### Configure Clerk sign-in and roles

In your Clerk dashboard:

1. Set **Sign-up mode** to **Restricted** so access is invitation based.
2. Enable the sign-in methods your team will use, such as email codes or Google. Production social sign-in requires your own provider credentials.
3. Leave **Organizations** off for a dedicated Vibase application. The Vibase deployment is the workspace; roles come from user metadata.
4. Under **Sessions → Customize session token**, add this claim while preserving any existing claims:

```json
{
  "vibase_role": "{{user.public_metadata.vibase_role}}"
}
```

Setup invites your first owner with the required public metadata. The role determines access:

| `vibase_role` | Access |
| --- | --- |
| Missing or unknown | No workspace access; Vibase returns `403 organization_forbidden`. |
| `member` | Broad workspace-wide CRM read/write access, including contacts, companies, deals, tasks, and notes. |
| `owner` | Full workspace access, including agent administration. |
| `agent` | Only explicitly granted scopes; a new agent account starts with none. |

**Why restrict sign-up?** This Clerk application controls entry to your organization's CRM. Restricted sign-up keeps account creation invitation based. Public sign-up alone does not grant Vibase access: a new account without a recognized role is refused. However, if you configure Clerk or an automation to assign `member` to every signup, anyone who signs up gains broad access to your workspace's CRM records.

Member permissions apply across the workspace, including records created by other people or agents. They are not limited to the member's own records; individual operations may still enforce additional ownership checks. Assign `member` only to people who should have that access, and use scoped agent identities for automations. See [workspaces, users, and agents](/concepts/workspaces-and-agents/) and [permissions and approvals](/concepts/permissions/) for details.

See Clerk's [session-token customization guide](https://clerk.com/docs/guides/sessions/customize-session-tokens) for the claims editor.

### Review OAuth, device login and the Clerk setup plan

Clerk also acts as the OAuth provider for Vibase clients. This is what allows the CLI to show a browser verification code and an MCP client to request consent.

Run the read-only setup plan, then read what it prints. The dry run reads configuration and the Clerk keys, and changes nothing:

```bash
npx @vibase/server-d1@<version> setup --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com --dry-run
```

Until the packages are on npm, run the same command from the release tarball:

```bash
npx --package ./vibase-server-d1-<version>.tgz vibase-server setup --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com --dry-run
```

**For production Clerk keys, add `--clerk-production` to every setup command, including dry runs.** Finish Clerk's Frontend API and Account Portal domain configuration before proceeding. The device verification page must be reachable on the Account Portal domain.

Setup prints a Clerk checklist. Review these settings:

| Setting | How it is configured |
| --- | --- |
| Restricted sign-up and sign-in methods | Set in the Clerk dashboard. |
| `vibase_role` session claim | Set in the dashboard; verified by your first successful owner sign-in. |
| Custom OAuth scopes | Add missing entries under **OAuth applications → Scopes**, using the exact keys and descriptions printed by setup. Keys include `contacts:read` and `contacts:write`. |
| JWT OAuth access tokens | Setup enables these; Vibase verifies JWT access tokens. |
| Dynamic client registration | Setup enables it for compatible MCP clients. |
| `Vibase CLI` OAuth application | Setup creates or updates a public client with consent, device authorization, the declared Vibase scopes, and `offline_access` for refresh tokens. |
| First owner | Setup invites the owner email or sets the owner role on an existing user that has no role. It refuses to overwrite an existing role. |

Rows marked `manual` still need your attention. A dry run can report a scope catalog as unverified; a real run checks whether Clerk accepts the declared scopes. If that check fails, add the scope entries printed in the report and rerun.

The CLI client ID is written to `AUTH_CLI_CLIENT_ID` in the instance configuration. You do not need to copy a client secret into the CLI. See Clerk's [device authorization guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant) for provider-side prerequisites.

### Apply Clerk setup

After addressing the checklist, run the same command without `--dry-run`:

```bash
npx @vibase/server-d1@<version> setup --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com
```

Or from the tarball, until the packages are on npm:

```bash
npx --package ./vibase-server-d1-<version>.tgz vibase-server setup --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com
```

Setup creates or adopts the Cloudflare resources, configures Clerk, writes the settings file, migrates the database, bootstraps the owner, deploys the Worker, sets its secrets and verifies it. It stops at the first failed step and names it; rerun the same command after correcting the problem. Existing matching configuration is retained.

A new instance's resources are named `vb-<env>` (Worker), `vb-crm-<env>` (D1), `vb-control-<env>` (the control-plane D1 database) and `vb-bodies-<env>` (R2). Setup creates the control database for every instance, migrates it before the CRM database, and pairs the two with a marker written after the CRM deployment row. A rerun takes the names recorded in the settings file and refuses a name flag that differs from them; an instance recorded without a control database gets one added on its next run. To adopt resources created under other names, such as an older `vault-<env>` instance with no settings file, pass `--worker-name`, `--d1-name`, `--control-d1-name` and `--r2-name` on the first run.

Check the deployment:

```bash
curl https://api.example.com/health
curl https://api.example.com/.well-known/vibase
```

Health should report an initialized instance with current migrations. Discovery should report Clerk authentication and a non-null `auth.cli_client_id`. Then tell the owner to accept the Clerk invitation and [sign in with the CLI](/getting-started/quickstart/).

## Check status

```bash
npx @vibase/server-d1@<version> status --env mycompany
```

Status verifies the package files, asks the live instance for its version and migration state, and prints the upgrade plan. It changes nothing. It exits 0 when the instance runs this release with current migrations, 1 when it is behind, and 2 when it refuses to continue.

On an instance with a control database it also prints, with the `[control]` prefix, what the next repair sweep would do: `sweep: N subject(s) pending revocation` (removed members and disabled agents that still hold sessions or tokens) and `sweep: M orphan account(s) pending deletion` (sign-ups older than 24 hours that no invitation completed). The sweep runs by itself every minute; the counts are read-only and never change the exit code. A count that cannot be read prints `sweep: counts unavailable`.

## Upgrade

Upgrading is running a newer, explicitly pinned version. Read the plan first, then apply it:

```bash
npx @vibase/server-d1@<version> upgrade --env mycompany --dry-run
npx @vibase/server-d1@<version> upgrade --env mycompany
```

Upgrade migrates the database, deploys the package's own Worker, verifies `/health` (version and commit) and runs a read-only smoke. An instance behind the migrations required by its code refuses API work with `503 migrations_pending`. If an upgrade fails after it began, run `status`, then upgrade again.

Upgrade moves an instance forward by version. When the instance already runs this version but from a different build (a different commit), it does not say "nothing to do": it prints `same version, different build: live <sha>, package <sha>`, changes nothing and exits 2, and `status` reports the same line and exits 1. To put this build on the instance, use redeploy.

## Redeploy

Redeploy puts the installed package's build on the instance, whatever is live: a new build of the same version, the same build again, or an older package over a newer instance (the rollback). It refuses no version or schema.

```bash
npx @vibase/server-d1@<version> redeploy --env mycompany --dry-run
npx @vibase/server-d1@<version> redeploy --env mycompany
```

It runs the same steps as upgrade (the migrations the instance lacks, control database first, then deploy, verify the version and commit on `/health`, smoke) and skips only the version and schema refusals. A database with nothing pending gets no migration command. If a failure happens after it began, run `status`, then redeploy again.

### Attach a schema file (custom objects and extension fields)

A custom object is declared in one JSON file (`version` 1, `define` keyed by `<key>__c`, and optionally `extend`, at most 256 KiB; the package ships its JSON Schema as `worker/vibase.schema.schema.json`). A schema change always ships through a redeploy:

```bash
npx @vibase/server-d1@<version> redeploy --env mycompany --schema ./vibase.schema.json --dry-run
npx @vibase/server-d1@<version> redeploy --env mycompany --schema ./vibase.schema.json
```

`extend` adds your own fields to the four built-in tables that take them: `extend.<object>.fields.<name>__c` for `contacts`, `companies`, `deals` or `tasks` (any other built-in is refused by name). A field is declared like a custom object's field (kind, `required`, `default`, `unique`, enum `values`, a reference to a contact, company, deal, task, principal or a custom object of the same file; a reference to a contact is valid from a custom object and from `extend.companies`, `extend.deals` and `extend.tasks`, while `extend.contacts` cannot reference contacts (`reference_contacts_self`; use an association). Merging two contacts re-points such references from the merged contact to the survivor). The Worker serves each field on create, update, get, list (as a filter), the MCP tools and the OpenAPI document; the plan lists it as `add: contacts.<name>__c` and its unique index as `index:`. A field removed from the file archives its column: the column stays, the field is no longer served, and nothing is dropped. A unique field on a built-in is for business keys (a customer number, an external id): it may not also have a `default`, because every contact, company, deal or task the vault creates itself takes the default and a second one would collide (`unique_with_default`; `required` with `unique` and no default is fine, the column stays empty on those rows). A channel identifier, such as a phone number or a direct-message handle, is an identity, not a unique extension field.

```json
{ "version": 1, "define": {}, "extend": { "contacts": { "fields": { "tier__c": { "kind": "enum", "values": ["standard", "gold"], "required": true, "default": "standard" } } } } }
```

The file is validated before anything is read or written. The plan then lists what would be created, added, indexed and archived, with the statements, and a refusal (a changed kind or target, a field made required, a unique field that live rows already violate) exits 2 with nothing changed. A real run applies the file's tables to the database after the core migrations, uploads the Worker with the file attached and records the file's absolute path in the settings file, so a later `redeploy` or `upgrade` attaches the same file again. If the apply fails, the run exits 3 at the step `apply` and a rerun plans what is left.

`/health` reports the attached file's SHA-256 digest and object names, and the extension fields as `fields` (sorted `<object>.<name>__c`, present only when the file extends; `/health.schema` is `null` when the file declares no objects and no extension fields), `status` prints it, and every redeploy or upgrade plan prints the live and the new digest. A run with no file is refused while the live Worker carries one, so a redeploy never drops the objects by accident: pass `--schema <path>`, or a file with an empty `define` and no `extend` (`{"version":1,"define":{}}`) to drop them on purpose; the tables are kept and reported as archived, never deleted. A Worker that cannot load its file answers every route but `/health` with `503 schema_invalid`.

**Rollback does not undo migrations.** Redeploy from an older installed release deploys that release's Worker over the newer schema and never reverses a migration; it prints `note: rolling back code; the database schema is newer than this build and is not reversed`. Cloudflare's own `wrangler rollback` has the same limit. Roll back a Worker only to a version whose code works with the current schema. (`upgrade --rollback` no longer exists: use redeploy.)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Setup stops at a named step | Fix the reported problem and rerun the same command. |
| Verify fails with `500` on `/.well-known/vibase` | The Worker has no `AUTH_SECRET` yet or it is not at every edge: rerun the same command. A wrong issuer or provider names what differs. |
| Verify says `not reachable yet`, or `status` says `cannot resolve <host> from this machine (DNS)` | The new host has no DNS answer on this machine yet. Wait a few minutes (or flush this machine's DNS cache) and run `vibase-server status --env <name>`. |
| The owner invitation link is lost | Setup shows it once and never again; recovery for a lost link is not part of this release. |
| Clerk (only with `--auth clerk`): Clerk refuses a custom scope | Add every scope named by the setup report to Clerk's OAuth scope catalog. |
| Clerk: device authorization is unavailable | Enable device authorization for `Vibase CLI` and ensure the Account Portal verification page is reachable. |
| Discovery reports `auth: null` or no CLI client ID | Rerun setup and read the failed verify row; on Clerk, complete the Clerk setup first. |
| The program refuses the secrets file | Make it readable by you only: `chmod 600`. |
| Owner login has no access (Clerk) | Check the accepted invitation, `public_metadata.vibase_role`, and the session-token claim. |

Gmail requires additional Google OAuth and Pub/Sub configuration. Consult the server package's README for the current checklist before connecting a mailbox. Once it is configured, connect the mailbox from **Connected accounts** in the app: after Google's consent the connect flow returns to your instance's own `/app/accounts` page unless you set `CONNECT_RETURN_URL` to send people elsewhere.

## From source

For development, or to deploy a change that is not in a release, work from a clone. This path deploys your checkout and keeps its configuration in `packages/server-d1/wrangler.jsonc`. It needs pnpm 10.7 and Git.

```bash
git clone https://github.com/benocodes/crm.git
cd crm
pnpm install
```

Put the Cloudflare credentials in a gitignored `.env` at the repository root, then review the plan and apply it. A new instance uses Better Auth: setup generates `AUTH_SECRET` into the gitignored `.env.mycompany` (and reads an optional Google pair from it). For Clerk, add `--auth clerk` and put the Clerk keys in that file:

```bash
pnpm -C packages/server-d1 setup:remote -- --env mycompany --api-host api.example.com --owner-email owner@example.com --dry-run
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env mycompany --api-host api.example.com --owner-email owner@example.com
```

The first real run writes the environment to `packages/server-d1/wrangler.jsonc` and stops. Review and commit that file, then rerun the same command with a clean working tree. Later, migrate before you deploy the new Worker:

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env mycompany
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env mycompany
```

To recover an owner on an instance deployed from source, run the twin of `owner-reset` (it reads `AUTH_SECRET` from the instance's own `.env.mycompany`, never the root `.env`):

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset [--email <owner>]
```

## Host your documentation separately

This documentation site is a static Astro build. It can run on Cloudflare Pages independently of any Vibase backend. See [publish these docs](/deployment/docs-site/).
