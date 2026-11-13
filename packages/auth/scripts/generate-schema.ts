// Prints (or, with --write, writes) the DDL of migration 0018 ([[CORE243]] D4): Better Auth's schema planner run offline against an empty SQLite, in the vault's names.
// The migration is reviewed and committed; `src/schema.test.ts` fails when what this prints differs from it, so a library or option change cannot alter the schema unnoticed.
//
//   pnpm -C packages/auth schema:generate [--write]
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateAuthDdl } from '../src/test/schema-gen.js'

const HEADER = `-- 0018: the auth tables of the built-in provider (CORE243 D4, D5). Generated offline by \`pnpm -C packages/auth schema:generate --write\` from Better Auth's own schema planner
-- (against an empty SQLite: its planner cannot introspect D1), then reviewed. Machinery, not resources: deployment-scoped (no organization_id), written only by Better Auth, never
-- by an operation, absent from schema discovery. Names are the vault's: auth_ prefixed, snake_case columns, ids from the vault's UUIDv7 generator. Timestamps are the ISO-8601
-- text Better Auth writes. No constraint is added beyond what Better Auth's own writes satisfy.
`
const target = fileURLToPath(new URL('../../storage-d1/migrations/0018_auth_tables.sql', import.meta.url))
const ddl = await generateAuthDdl()
if (process.argv.includes('--write')) {
  writeFileSync(target, `${HEADER}\n${ddl.trim()}\n`)
  console.log(`wrote ${target}`)
} else console.log(ddl)
