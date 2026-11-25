// Writes `vibase.schema.schema.json` from the schema file's validator ([[CORE542]] D26): `pnpm -C packages/server-d1 schema:json`. `src/schema-file-json.test.ts` fails when the checked-in file differs.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { schemaFileJsonSchema } from '@vibase/api'

writeFileSync(
  fileURLToPath(new URL('../vibase.schema.schema.json', import.meta.url)),
  `${JSON.stringify(schemaFileJsonSchema(), null, 2)}\n`,
)
