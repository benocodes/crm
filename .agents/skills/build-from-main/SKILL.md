---
name: build-from-main
description: Pull main, build the tarballs from the code into ~/vibase-build, verify the checksums, and tell the user the exact commands to deploy them (the `vs` shell function, then `upgrade` or `redeploy`). A local build from source, not a release: nothing is tagged, published or run on CI. Use when the user says "pull and rebuild", "rebuild the tarballs", "new build", or asks to refresh ~/vibase-build.
---

# Build from main

A **local build from the code, not a release**: no tag, no CI run, no draft GitHub Release, no npm publish (the release flow is `ship-branch`,
"Command reference"). It refreshes `~/vibase-build/` (the scratch folder that holds only the tarballs, so nothing from the repo leaks into `npx`) from current `main`,
then prints the commands the user runs to deploy it. It builds locally and **runs no remote command**: `upgrade`, `redeploy` and `status` against
`hq`, `makelinks` or any other instance are the user's (AGENTS.md, "Environments"; only `smoked1` is the agents').
The full deploy recipe is `knowledge/recipes/deploy-a-new-instance.md`.

## Steps

Run from the main checkout (`/Users/ori/Code/crm`). Never pipe the build through `tail` or `grep`: let its output stream.

1. **Remember what is there.** `ls ~/vibase-build/*.tgz` and note the version in the old file names (`vibase-server-d1-<old>.tgz`); it decides
   upgrade or redeploy below. The folder may be empty or missing on a first run.
2. **Pull.** `git status --short` must be empty (`release:build` refuses a dirty tree; report the dirty files and stop, do not use
   `--allow-dirty` unless the user asks). Then `git pull --ff-only` and `git log --oneline -5`.
3. **Build.** `pnpm release:build`. It prints `version <v>, commit <sha>`; keep both.
4. **Refresh the folder.** Replace the old files so only one version is there:
   ```bash
   mkdir -p ~/vibase-build && rm -f ~/vibase-build/*.tgz ~/vibase-build/SHA256SUMS \
     && cp packages/release/dist/* ~/vibase-build/ \
     && (cd ~/vibase-build && shasum -a 256 -c SHA256SUMS)
   ```
5. **Report** in a few lines: the short sha, the version, what changed since the old build when it matters (`git log --oneline <old-sha>..HEAD` if the old
   sha is known, otherwise the last few commits; say whether any of it changes the Worker or the migrations, or is tests and docs only), and the
   commands below with the real version filled in.

## What to tell the user

The `vs` function (a function, not a variable: zsh does not word-split `$VS`), with the built version in the file name:

```bash
cd ~/vibase-build
vs() { npx --yes --package ./vibase-server-d1-<version>.tgz vibase-server "$@"; }
```

Then, per instance (`hq`, `makelinks`, ...):

- **The version changed** from the one in the folder before (for example 0.1.0 to 0.2.1): the normal path.
  ```bash
  vs status --env <env>
  vs upgrade --env <env> --dry-run     # read the migration list before confirming
  vs upgrade --env <env>
  ```
  `upgrade` migrates the control and CRM databases first, then deploys. Say whether the dry run is likely to show new migrations (the commits touch
  `packages/*/migrations` or a spec says so).
- **The version is the same** and only the build differs (`status` says `same version, different build`): `upgrade` refuses; use
  ```bash
  vs redeploy --env <env> --dry-run
  vs redeploy --env <env>
  ```
  `redeploy` puts this build on whatever is live and applies only the migrations the instance lacks. A rollback is `redeploy` run from an older
  package.
- **Nothing in the Worker changed** (only tests, docs, scripts): say a redeploy is optional; the sha will differ, so `status` will call the
  instance behind.

Mention a deploy-time side effect only when the commits show one (for example a renamed path that needs a third-party console change, as in
milestone S: the redirect URIs and the Pub/Sub push endpoint).

`smoked1` is the exception: agents may run `vibase-server status`, `upgrade` and `redeploy` against it (with `--yes`); do it only when the user asks.
