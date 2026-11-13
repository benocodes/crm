---
title: Run an instance
description: Set up, check and upgrade a Vibase instance in your own Cloudflare account with the vibase-server program.
---

Each Vibase workspace runs in its owner's Cloudflare account. The backend is a Worker and one D1 database, with R2 for raw message bodies and files. Clerk provides sign-in, OAuth consent, and CLI device login in the current version. **Support for other authentication providers is coming soon.**

This page is for the person who runs the instance. If an instance already exists and you only want to use it, see [using Vibase](/getting-started/quickstart/). Running an instance needs no checkout of the repository: the release's server package, `@vibase/server-d1`, carries the Worker, the connect page, the database migrations and the `vibase-server` program that sets up, checks and upgrades an instance. Developers who work from a clone have [a source path](#from-source) at the end of this page.

## Prepare your accounts

You need:

- Node.js 22.12 or later.
- A Cloudflare account and an API hostname on a zone in that account, such as `api.example.com`.
- A Clerk application dedicated to this workspace. A development instance works for an evaluation; use a production instance for your deployed business workspace.
- An email address for the workspace's first owner.

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

Create the secrets file with your Cloudflare access and the Clerk application's keys:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLERK_SECRET_KEY=your_clerk_secret_key
CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
```

The Cloudflare token needs these permissions:

| Scope | Permissions |
| --- | --- |
| Account | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers Tail Read, Account Settings Read |
| The API hostname's zone | Zone Read, Workers Routes Edit |

Copy both Clerk keys from the same Clerk instance; setup derives the issuer and the JWT verification key. To keep the files elsewhere, name them on every command:

```bash
npx @vibase/server-d1@<version> status --env mycompany --settings ./mycompany.json --secrets-file ./mycompany.env
```

Remote commands need `CONFIRM_REMOTE=1` in the environment; a `--dry-run` reads only and does not.

## Configure Clerk sign-in and roles

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

## Review OAuth, device login and the setup plan

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

## Apply setup

After addressing the checklist, run the same command without `--dry-run`:

```bash
CONFIRM_REMOTE=1 npx @vibase/server-d1@<version> setup --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com
```

Or from the tarball, until the packages are on npm:

```bash
CONFIRM_REMOTE=1 npx --package ./vibase-server-d1-<version>.tgz vibase-server setup --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com
```

Setup creates or adopts the Cloudflare resources, configures Clerk, writes the settings file, migrates the database, bootstraps the owner, deploys the Worker, sets its secrets and verifies it. It stops at the first failed step and names it; rerun the same command after correcting the problem. Existing matching configuration is retained.

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

## Upgrade

Upgrading is running a newer, explicitly pinned version. Read the plan first, then apply it:

```bash
npx @vibase/server-d1@<version> upgrade --env mycompany --dry-run
CONFIRM_REMOTE=1 npx @vibase/server-d1@<version> upgrade --env mycompany
```

Upgrade migrates the database, deploys the package's own Worker, verifies `/health` and runs a read-only smoke. An instance behind the migrations required by its code refuses API work with `503 migrations_pending`. If an upgrade fails after it began, run `status`, then upgrade again.

**Rollback does not undo migrations.** `upgrade --rollback`, run from an older installed release, deploys that release's Worker and runs no migration; the database stays at its newer schema. Cloudflare's own `wrangler rollback` has the same limit. Roll back a Worker only to a version whose code works with the current schema.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Setup stops at a named step | Fix the reported problem and rerun the same command. |
| Clerk refuses a custom scope | Add every scope named by the setup report to Clerk's OAuth scope catalog. |
| Device authorization is unavailable | Enable device authorization for `Vibase CLI` and ensure the Account Portal verification page is reachable. |
| Discovery reports `auth: null` or no CLI client ID | Complete the Clerk setup and rerun setup. |
| The program refuses the secrets file | Make it readable by you only: `chmod 600`. |
| Owner login has no access | Check the accepted invitation, `public_metadata.vibase_role`, and the session-token claim. |

Gmail requires additional Google OAuth and Pub/Sub configuration. Consult the server package's README for the current checklist before connecting a mailbox.

## From source

For development, or to deploy a change that is not in a release, work from a clone. This path deploys your checkout and keeps its configuration in `packages/server-d1/wrangler.jsonc`. It needs pnpm 10.7 and Git.

```bash
git clone https://github.com/benocodes/crm.git
cd crm
pnpm install
```

Put the Cloudflare credentials in a gitignored `.env` at the repository root and the Clerk keys in `.env.mycompany`, then review the plan and apply it:

```bash
pnpm -C packages/server-d1 setup:remote -- --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com --dry-run
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env mycompany --auth clerk --api-host api.example.com --owner-email owner@example.com
```

The first real run writes the environment to `packages/server-d1/wrangler.jsonc` and stops. Review and commit that file, then rerun the same command with a clean working tree. Later, migrate before you deploy the new Worker:

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env mycompany
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env mycompany
```

## Host your documentation separately

This documentation site is a static Astro build. It can run on Cloudflare Pages independently of any Vibase backend. See [publish these docs](/deployment/docs-site/).
