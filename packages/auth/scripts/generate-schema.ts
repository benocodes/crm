// Prints Better Auth's DDL ([[CORE243]] D4): its schema planner run offline against an empty SQLite, in Vibase's names. It writes nothing ([[CORE678]] D6).
// Control genesis (`packages/storage-d1/control-migrations/0001_genesis.sql`) begins with this DDL, then `CONTROL_DEPLOYMENT_DDL`; `src/schema.test.ts` fails when what this prints
// differs from the head of that file, so a library or option change cannot alter the schema unnoticed. Genesis is frozen ([[OPS681]]): a Better Auth DDL change goes into a new control migration,
// and `schema.test` will then need reworking to compare against the migrated schema, not the genesis head.
//
//   pnpm -C packages/auth schema:generate
import { generateAuthDdl } from '../src/test/schema-gen.js'

console.log(await generateAuthDdl())
