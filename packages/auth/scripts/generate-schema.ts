// Prints (or, with --write, writes) the DDL of control migration 0001 ([[CORE243]] D4): Better Auth's schema planner run offline against an empty SQLite, in the vault's names.
// The migration is reviewed and committed; `src/schema.test.ts` fails when what this prints differs from it, so a library or option change cannot alter the schema unnoticed.
//
//   pnpm -C packages/auth schema:generate [--write]
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONTROL_DEPLOYMENT_DDL, generateAuthDdl } from '../src/test/schema-gen.js'

const HEADER = `-- Control 0001 (CORE259 D4, D7, D13; the auth tables are CORE243 D4, D5). The control-plane database's first compiled migration, applied to the control database with its own d1_migrations tracker.
-- The auth tables are generated offline by \`pnpm -C packages/auth schema:generate --write\` from Better Auth's own schema planner (against an empty SQLite: its planner cannot
-- introspect D1), then reviewed. Machinery, not resources: deployment-scoped (no organization_id), written only by Better Auth, never by an operation. Names are the vault's: auth_
-- prefixed, snake_case columns, ids from the vault's UUIDv7 generator. Timestamps are the ISO-8601 text Better Auth writes. control_deployment is the control marker: it names the
-- one organisation this control plane serves and is compared with the CRM database's deployment row (D7). No foreign key or trigger reaches the CRM database (D8).
`
const target = fileURLToPath(new URL('../../storage-d1/control-migrations/0001_control_plane.sql', import.meta.url))
const ddl = await generateAuthDdl()
if (process.argv.includes('--write')) {
  writeFileSync(target, `${HEADER}\n${ddl.trim()}\n\n${CONTROL_DEPLOYMENT_DDL}`)
  console.log(`wrote ${target}`)
} else console.log(ddl)
