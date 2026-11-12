---
title: Self-host Vibase
description: Prepare a customer-owned Cloudflare deployment with D1 and Clerk.
---

Each Vibase workspace runs in its owner's Cloudflare account. The backend uses a Worker and one D1 database, with R2 for raw message bodies and files. Clerk provides sign-in, OAuth consent, and CLI device login in the current version. Support for other authentication providers is coming soon.

For a first deployment, follow the [Clerk quickstart](/getting-started/quickstart/). It covers account credentials, roles, custom scopes, the CLI OAuth application, and the first owner sign-in. This page covers the setup lifecycle and later maintenance.

## Prepare your accounts

You need a Cloudflare account with Wrangler access, an API hostname you control, and a Clerk application for this workspace. Keep instance credentials in a gitignored `.env.<environment>` file at the repository root.

The setup script reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from that file. It never needs a key embedded in a command. For a production Clerk instance, review the script's `--clerk-production` option and production-domain prerequisites first.

## Review the setup plan

From the repository root:

```bash
pnpm -C packages/server-d1 setup:remote -- \
  --env mycompany \
  --api-host api.example.com \
  --owner-email owner@example.com \
  --dry-run
```

The dry run reads configuration and reports the proposed steps. It does not create resources or deploy.

## Apply setup

After reviewing the plan:

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- \
  --env mycompany \
  --api-host api.example.com \
  --owner-email owner@example.com
```

The first run prepares resources and Clerk, writes the environment to `packages/server-d1/wrangler.jsonc`, and stops. Review and commit that configuration, then rerun the same command with a clean working tree to migrate, bootstrap, deploy, set secrets, and verify. Include `--clerk-production` on every run with production Clerk keys. Follow the manual steps in the Clerk report, then verify `/health` and sign in with the [CLI](/guides/cli/).

Gmail requires additional Google OAuth and Pub/Sub configuration. Consult the repository's server package README for the current setup checklist before connecting a mailbox.

## Update an existing instance

Migrate before deploying the new Worker:

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env mycompany
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 deploy:remote -- --env mycompany
```

The Worker checks its database migration state. An instance behind the migrations required by its code refuses API work with `503 migrations_pending`.

## Host your documentation separately

This documentation site is a static Astro build. It can run on Cloudflare Pages independently of any Vibase backend. See [publish these docs](/deployment/docs-site/).
