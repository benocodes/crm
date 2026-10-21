# Atomic operation experiment (CORE33)

Private experiment: the application does not import this package. Task title/notes/status updates
and identity resolution share SQL business definitions; PostgreSQL uses the existing tenancy wrapper,
and local D1 uses one actual Worker binding batch. Product migrations and routes remain unchanged.

Run in `.claude/worktrees/core33`, with inherited database URLs cleared, after `pnpm install` and
`pnpm db:test:worktree`. Tests and smoke refuse any database other than `vault_test_core33`.

```
pnpm -C packages/storage-prototype test
pnpm -C packages/storage-prototype typecheck
pnpm -C packages/storage-prototype smoke
pnpm -C packages/storage-prototype smoke:remote
```

Tests use local Postgres and in-memory Miniflare bindings, so require permission to open local sockets.
Files run serially; never run another suite or reset against this database at the same time.
Fixtures remove their nonpublic schema and close pools/Workers. Do not deploy `src/test/batch-worker.mjs`:
it is a raw-SQL transport for local tests only.

The SQL kit handles dialect syntax, JSON representation, timestamps, parameterization, and fixture
relation names. Business predicates live in `src/operations/`. Runtimes execute precompiled statements;
result decoding occurs after the entire transaction/batch, including cleanup, commits. Thus an
unexpected codec failure can report failure after writes commit. No automatic replay is attempted.

The knowledge repository's CORE33 `RESULT.md` records evidence, measurements, and limitations.
Remote D1 is unverified without an existing authorized disposable binding runner. This package does
not enable D1 as an application backend, prove public cursor ordering, or provide portable authentication.
