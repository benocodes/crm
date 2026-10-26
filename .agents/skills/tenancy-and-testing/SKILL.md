---
name: tenancy-and-testing
description: How tenancy works on each storage engine (single-organisation D1, multi-tenant Postgres with RLS) and how tests must exercise it without masking it or leaking state. Use when adding a tenant table, writing or changing a test harness, writing tests that touch isolation, or touching the open/enterprise package boundary.
---

# Tenancy and testing, per engine

AGENTS.md states the rules in one line each (invariants 1, 2 and 10). This skill holds the mechanism. Rules
that are about Postgres roles and grants live in `db-schema-and-migrations`; Hyperdrive pooling lives in
`hyperdrive-pg-rls`; the prepared-resource seam lives in `api-routes`.

## Tenancy per engine ([[CORE35]] D6, D18)

| | Postgres (multi-tenant, cloud and enterprise) | D1 (single organisation, self-hosted MVP) |
|---|---|---|
| Boundary | `organization_id` is the RLS gate | the database itself |
| Enforcement | RLS in the same migration that creates the table; only the scoping wrappers set role or session config | `organizations.id` references the singleton deployment marker; every tenant table has a foreign key onto `organizations`; D1 always enforces foreign keys, so a second organisation cannot be stored |
| Shared programs | write `organization_id` | write `organization_id` too, but no D1 guarantee depends on it; RLS is not emulated |
| Foreign identity | refused by RLS (`42501`) | refused before any SQL by the storage layer |

Every tenant table on either engine also carries `user_id`/actor attribution.

## The harness must not mask tenancy

**Postgres.**
- Do not preset `app.organization_id` or `service_role` on the test pool. A query that skips its tenancy
  wrapper must fail in tests the way it does in production.
- `createTestDb` (`@vault/db/test`) connects as `vault_app`, which holds no table privileges until a wrapper
  runs `SET LOCAL ROLE`. `harness.integration.test.ts` guards this.

**D1.**
- Each test organisation gets its own disposable binding (in-memory Miniflare), so there is no shared
  state to filter through.
- A foreign organisation's identity must be refused, not filtered. Test the refusal, and test that a second
  organisation fails on a foreign key.

## Tests leave no persistent state

See `writing-tests` section 4 (the CORE35 F5 lesson: restore state in teardown, assert the production state
in the harness, verify from a fresh database).

## Open packages never import enterprise code ([[CORE35]] D14, D15)

`@vault/storage` and `@vault/storage-d1` are open source and must not import `@vault/storage-postgres`,
`@vault/db` or `pg`. `packages/storage/src/import-boundary.test.ts` enforces it.

- In `packages/api`, production code may not import `pg` or `@vault/storage-postgres` either. The named
  exceptions are composition entry points, listed by file name in the test's allow-list with the reason
  (`src/dev-server.ts`, and `scripts/` files such as `golden.ts`, `smoke-auth.ts`, `smoke-admin.ts`), until
  the CORE37 cutover splits the Worker entry by engine (D21).
- Never allow a whole directory with an empty-string key; a rule that exempts every file forbids nothing.
  Add a sandbox case showing an unlisted file that imports enterprise code fails.
