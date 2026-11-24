import {
  DeclarationError,
  KEY_SUFFIX,
  NAME_MAX,
  NAME_SHAPE,
  FIELDS_MAX,
  parseField,
  type FieldDeclaration,
} from './declaration.js'

// The `extend` section of the extensions file ([[CORE315]] D7, D8, D9; [[CORE555]] P1, P2): `extend.<object>.fields.<name>__c`, the declarations of fields added to a built-in table. Plain data, validated here; the extensions file carries it as its `extend` key ([[CORE561]]).

/** D7: the built-in tables that take extension fields. */
export const EXTENSIBLE_OBJECTS = ['contacts', 'companies', 'deals', 'tasks'] as const
export type ExtensibleObject = (typeof EXTENSIBLE_OBJECTS)[number]
/** The built-ins that are closed to extension (D7): refused by name, apart from a name nobody knows. */
export const CLOSED_BUILTINS: readonly string[] = [
  'messages',
  'threads',
  'interactions',
  'identities',
  'notes',
  'tags',
  'associations',
  'pipelines',
  'pipeline_stages',
  'principals',
  'events',
  'forms',
  'connections',
  'files',
  'webhooks',
  'action_requests',
  'action_executions',
]
/** Extension fields declared per built-in table, keyed by the stored column name (`<name>__c`). */
export type ExtendDeclarations = Partial<Record<ExtensibleObject, Record<string, FieldDeclaration>>>

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates an `extend` section. `customKeys` are the custom objects declared in the same file: a reference may target one, no other `__c` name. */
export function parseExtend(input: unknown, customKeys: readonly string[] = []): ExtendDeclarations {
  if (!isObject(input))
    throw new DeclarationError('not_an_object', 'extend is a map from object to its fields', 'extend')
  const out: ExtendDeclarations = {}
  for (const [object, decl] of Object.entries(input)) {
    const at = `extend.${object}`
    if (!(EXTENSIBLE_OBJECTS as readonly string[]).includes(object))
      throw new DeclarationError(
        CLOSED_BUILTINS.includes(object) ? 'object_closed' : 'object_unknown',
        CLOSED_BUILTINS.includes(object)
          ? `${object} is closed to extension; only ${EXTENSIBLE_OBJECTS.join(', ')} take fields`
          : `${object} is not an object that takes extension fields (${EXTENSIBLE_OBJECTS.join(', ')})`,
        at,
      )
    if (!isObject(decl)) throw new DeclarationError('not_an_object', 'an extended object is { fields }', at)
    for (const k of Object.keys(decl))
      if (k !== 'fields')
        throw new DeclarationError('unknown_property', `"${k}" is not a property of an extended object`, `${at}.${k}`)
    if (!isObject(decl.fields))
      throw new DeclarationError('fields_missing', 'an extended object lists its fields', `${at}.fields`)
    const names = Object.keys(decl.fields)
    if (names.length > FIELDS_MAX)
      throw new DeclarationError(
        'too_many_fields',
        `an object declares at most ${FIELDS_MAX} extension fields`,
        `${at}.fields`,
      )
    const fields: Record<string, FieldDeclaration> = {}
    for (const key of names) {
      const fat = `${at}.fields.${key}`
      const fail = (rule: string, message: string): never => {
        throw new DeclarationError(rule, message, fat)
      }
      if (!key.endsWith(KEY_SUFFIX)) fail('field_key_suffix', `an extension field's name ends in ${KEY_SUFFIX}`)
      const base = key.slice(0, -KEY_SUFFIX.length)
      if (base.includes('__'))
        fail('field_name_double_underscore', 'a field name has no double underscore before its suffix')
      if (!NAME_SHAPE.test(base))
        fail('field_name_shape', 'a field name is lowercase snake_case starting with a letter')
      if (base.length > NAME_MAX)
        fail('field_name_length', `a field name is at most ${NAME_MAX} characters before ${KEY_SUFFIX}`)
      const f = parseField(decl.fields[key], fat)
      if (f.kind === 'reference' && f.target?.endsWith(KEY_SUFFIX) && !customKeys.includes(f.target))
        throw new DeclarationError('reference_target_undeclared', `${f.target} is not a declared custom object`, fat)
      fields[key] = f
    }
    out[object as ExtensibleObject] = fields
  }
  return out
}
