// The attached schema file as text ([[CORE315]] D27, [[CORE543]] P7). A deploy stages `vibase.schema.json` beside the Worker with a `Text` rule, so the import is the file's text; the repo's builds resolve the checked-in empty
// default in this folder. TypeScript resolves a `.json` import as parsed JSON (the package's other suites need `resolveJsonModule`), so the type is stated here, once.
import json from './vibase.schema.json'

export const schemaFileText: string = json as unknown as string
