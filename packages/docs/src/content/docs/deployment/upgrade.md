---
title: Upgrade, redeploy and roll back
description: Check an instance, move it to a newer version, put a build on it, and what a rollback does not undo.
---

Install the version you want, then run the command against your instance. The installed package is the version that deploys.

```bash
npm install -g @vibase/server-d1@<version>
```

Versions are listed on the repository's Releases page.

## Check status

```bash
vibase-server status --env mycompany
```

Status verifies the package files, asks the live instance for its version and migration state, and prints the upgrade plan. It changes nothing. It exits 0 when the instance runs this release with current migrations, 1 when it is behind, and 2 when it refuses to continue.

On an instance with a control database it also prints, with the `[control]` prefix, what the next repair sweep would do: `sweep: N subject(s) pending revocation` (removed members and disabled agents that still hold sessions or tokens) and `sweep: M orphan account(s) pending deletion` (sign-ups older than 24 hours that no invitation completed). The sweep runs by itself every minute; the counts are read-only and never change the exit code. A count that cannot be read prints `sweep: counts unavailable`.

## Upgrade

Upgrading is running a newer, explicitly pinned version. Read the plan first, then apply it:

```bash
vibase-server upgrade --env mycompany --dry-run
vibase-server upgrade --env mycompany
```

Upgrade migrates the database, deploys the package's own Worker, verifies `/health` (version and commit) and runs a read-only smoke. An instance behind the migrations required by its code refuses API work with `503 migrations_pending`. If an upgrade fails after it began, run `status`, then upgrade again.

Upgrade moves an instance forward by version. When the instance already runs this version but from a different build (a different commit), it does not say "nothing to do": it prints `same version, different build: live <sha>, package <sha>`, changes nothing and exits 2, and `status` reports the same line and exits 1. To put this build on the instance, use redeploy.

## Redeploy

Redeploy puts the installed package's build on the instance, whatever is live: a new build of the same version, the same build again, or an older package over a newer instance (the rollback). It refuses no version or schema.

```bash
vibase-server redeploy --env mycompany --dry-run
vibase-server redeploy --env mycompany
```

It runs the same steps as upgrade (the migrations the instance lacks, control database first, then deploy, verify the version and commit on `/health`, smoke) and skips only the version and schema refusals. A database with nothing pending gets no migration command. If a failure happens after it began, run `status`, then redeploy again.

## Custom objects and fields

A change to your schema file ships through `redeploy --schema <file>`. The file's format, the plan it prints and its limits are in [custom objects and fields](/guides/schema/).

**Rollback does not undo migrations.** Redeploy from an older installed release deploys that release's Worker over the newer schema and never reverses a migration; it prints `note: rolling back code; the database schema is newer than this build and is not reversed`. Cloudflare's own `wrangler rollback` has the same limit. Roll back a Worker only to a version whose code works with the current schema. (`upgrade --rollback` no longer exists: use redeploy.)
