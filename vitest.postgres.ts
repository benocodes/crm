// The Postgres test switch (2026-11-02): the MVP is D1 only, so every suite that needs a Postgres database is off by
// default and costs nothing. `VAULT_TEST_POSTGRES=1` (or `pnpm test:postgres`) turns them back on, unchanged.
// Whole files that only make sense on Postgres are listed per package in its vitest config (`postgresOnly`);
// suites that run on both engines take their engine list from `ENGINE_NAMES` in `packages/api/src/test/engines.ts`.
export const postgresTests = process.env.VAULT_TEST_POSTGRES === '1'

/** Globs to exclude from a package's run: the Postgres-only files, unless Postgres tests are on. */
export const postgresOnly = (files: string[]): string[] => (postgresTests ? [] : files)
