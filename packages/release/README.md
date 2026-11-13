# @vibase/release

The product release ([[OPS210]]): the one product version (the fixed changesets group of `packages/cli` and `packages/server-d1`, not this package), the build of the two published packages and the check that proves they run outside the repo.

- `pnpm release:build [--allow-dirty]` writes `dist/vibase-cli-<version>.tgz` (`@vibase/cli`), `dist/vibase-server-d1-<version>.tgz` (`@vibase/server-d1`) and one `dist/SHA256SUMS`. Nothing is published.
- `pnpm release:check [<cli tarball> <server tarball>]` verifies, scans and installs each tarball into its own empty directory and runs it.
- `templates/` holds the two published `README.md`s; the two published `package.json`s are generated in `src/stage.ts`. Workspace names stay `@vibase/*`.

## Releasing (maintainers; [[OPS210]] D19, D24, D25)

Versions come from `@changesets/cli`: `@vibase/cli` and `@vibase/server-d1` are one `fixed` group (`.changeset/config.json`) and always carry the same version. Nothing here publishes by itself.

1. A pull request that changes what a published package ships adds a changeset: `pnpm changeset` (choose either package; the group bumps together; `0.x`: a breaking change is a minor).
2. On push to `main`, `.github/workflows/version.yml` opens or updates the **Version Packages** pull request (both `package.json` versions and both `CHANGELOG.md`s). It never publishes. The repository setting "Allow GitHub Actions to create and approve pull requests" must be on.
3. A person merges that pull request.
4. A person pushes the tag `v<version>` (exactly the new version; a prerelease such as `v0.2.0-rc.0` is accepted when the version equals it). `.github/workflows/release.yml` checks the tag against the version, runs the gate, `release:build` and `release:check`, and creates a **draft** GitHub Release with both tarballs and `SHA256SUMS`. A mismatched tag fails before the gate; an existing release is never replaced.
5. A person checks the tarballs against `SHA256SUMS`, runs `npm publish` for `@vibase/server-d1` and then `@vibase/cli` from the tarballs, and publishes the draft. No workflow does 5; there is no npm token in the repository, and the workspace packages are `private` so `changeset publish` would publish nothing.

`release.yml` also runs on `workflow_dispatch` (build and upload the tarballs as a workflow artifact for 7 days, no release). `pnpm release:ci tag|assets` are its two checks.
