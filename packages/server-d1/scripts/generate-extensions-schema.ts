// Writes `vibase-extensions.schema.json` from the extensions file's validator ([[CORE542]] D26): `pnpm -C packages/server-d1 schema:extensions`. `src/extensions-schema.test.ts` fails when the checked-in file differs.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extensionsJsonSchema } from '@vibase/api'

writeFileSync(
  fileURLToPath(new URL('../vibase-extensions.schema.json', import.meta.url)),
  `${JSON.stringify(extensionsJsonSchema(), null, 2)}\n`,
)
