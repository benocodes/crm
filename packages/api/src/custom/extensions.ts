import { z } from 'zod'
import {
  DeclarationError,
  fieldSchema,
  objectSchema,
  parseObjectDeclarations,
  type ObjectDeclaration,
} from './declaration.js'
import { EXTENSIBLE_OBJECTS, parseExtend, type ExtendDeclarations } from './extend.js'

// The extensions file ([[CORE315]] D5, D26; [[CORE542]]): one plain JSON file, `version` 1, `objects` keyed by `<key>__c`. Every refusal is a `DeclarationError` with a stable rule code and a path in the file.
// The published JSON Schema is generated from the same zod schema; it is necessary, not sufficient (P6): the cross-field rules (sibling targets, `default` per kind, `unique` per kind) live in the declaration validator only.

/** The longest file, in bytes (D26); a longer one is refused before it is parsed. */
export const MAX_FILE_BYTES = 256 * 1024

export interface ExtensionsFile {
  version: 1
  $schema?: string
  objects: Record<string, ObjectDeclaration>
  /** Extension fields of the built-ins ([[CORE561]]); absent when the file has no `extend` key. */
  extend?: ExtendDeclarations
}

/** `extend` as the published JSON Schema shows it: the four extensible built-ins, each `{ fields }` of field declarations. Necessary, not sufficient: `parseExtend` holds the name and reference rules. */
const extendSchema = z.partialRecord(
  z.enum(EXTENSIBLE_OBJECTS),
  z.strictObject({ fields: z.record(z.string(), fieldSchema) }),
)

/** The envelope as zod sees it; the strict object refuses every other key. */
export const extensionsFileSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  objects: z.record(z.string(), objectSchema),
  extend: extendSchema.optional(),
})

/** The JSON Schema of the file (checked in to `@vibase/server-d1` as `vibase-extensions.schema.json`, and shipped beside the Worker). */
export function extensionsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(extensionsFileSchema, { target: 'draft-2020-12' }) as Record<string, unknown>
}

/** Validates the file's text: size first, then JSON, the envelope, then each declaration (sibling targets across the file). Returns the normalised file or throws a `DeclarationError`. */
export function parseExtensionsFile(text: string): ExtensionsFile {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES)
    throw new DeclarationError('file_too_large', `the extensions file is at most ${MAX_FILE_BYTES} bytes`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DeclarationError('invalid_json', 'the extensions file is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new DeclarationError('not_an_object', 'the extensions file is a JSON object')
  const top = raw as Record<string, unknown>
  for (const k of Object.keys(top))
    if (k !== '$schema' && k !== 'version' && k !== 'objects' && k !== 'extend')
      throw new DeclarationError('unknown_key', `"${k}" is not a key of the extensions file`, k)
  if (top.version !== 1) throw new DeclarationError('version_invalid', 'version is 1', 'version')
  if (top.$schema !== undefined && typeof top.$schema !== 'string')
    throw new DeclarationError('schema_invalid', '$schema is a string', '$schema')
  if (!('objects' in top)) throw new DeclarationError('objects_missing', 'the file names its objects', 'objects')
  const objects = top.objects
  if (typeof objects !== 'object' || objects === null || Array.isArray(objects))
    throw new DeclarationError('not_an_object', 'objects is a map from key to declaration', 'objects')
  let declared: Record<string, ObjectDeclaration>
  try {
    declared = parseObjectDeclarations(objects)
  } catch (e) {
    if (e instanceof DeclarationError)
      throw new DeclarationError(
        e.rule,
        e.message.replace(`${e.path}: `, ''),
        e.path === '' ? 'objects' : `objects.${e.path}`,
      )
    throw e
  }
  // [[CORE561]] D5, D26: `extend` is validated after the objects, with the file's own object keys as the custom targets a reference may name. Its refusals carry their own `extend.` paths.
  const extend = 'extend' in top ? parseExtend(top.extend, Object.keys(declared)) : undefined
  return {
    version: 1,
    ...(top.$schema !== undefined ? { $schema: top.$schema as string } : {}),
    objects: declared,
    ...(extend !== undefined ? { extend } : {}),
  }
}
