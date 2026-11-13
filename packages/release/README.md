# @vibase/release

The product release ([[OPS210]]): the one product version (`package.json`), the build of the two published packages and the check that proves they run outside the repo.

- `pnpm release:build [--allow-dirty]` writes `dist/vibase-cli-<version>.tgz` (`@vibase/cli`), `dist/vibase-server-d1-<version>.tgz` (`@vibase/server-d1`) and one `dist/SHA256SUMS`. Nothing is published.
- `pnpm release:check [<cli tarball> <server tarball>]` verifies, scans and installs each tarball into its own empty directory and runs it.
- `templates/` holds the two published `README.md`s; the two published `package.json`s are generated in `src/stage.ts`. Workspace names stay `@vibase/*`.
