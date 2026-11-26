---
title: Deploy from source
description: Deploy a checkout of the repository instead of a release, for development or a change that is not released yet.
---

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
