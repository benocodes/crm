import { z } from 'zod'

// The declaration of a custom object ([[CORE315]] D6, D9, D18, D19): plain data, validated here, refused with the broken rule named.
// A broken declaration throws `DeclarationError`: `rule` is a stable code (what a test and a tool read), `path` says where, the message says it in a sentence.

/** The closed list of field kinds (D18). `reference` joins in a later release (P1) and is refused by name until then. */
export const FIELD_KINDS = ['text', 'integer', 'boolean', 'timestamp', 'enum'] as const
export type FieldKind = (typeof FIELD_KINDS)[number]
export type FieldDefault = string | number | boolean

export interface FieldDeclaration {
  kind: FieldKind
  label?: string
  description?: string
  /** Default false. A required field with no default must be given on create. */
  required?: boolean
  /** A constant, never for a timestamp. */
  default?: FieldDefault
  /** An enum's values: the only ones create and update accept (D20). */
  values?: string[]
}
export interface ObjectDeclaration {
  label?: string
  description?: string
  fields: Record<string, FieldDeclaration>
}

export class DeclarationError extends Error {
  override name = 'DeclarationError'
  constructor(
    /** The rule that was broken, a stable code such as `key_suffix`. */
    readonly rule: string,
    message: string,
    /** Where: the object key, then `fields.<name>`; empty when the input is the whole map. */
    readonly path: string = '',
  ) {
    super(path === '' ? message : `${path}: ${message}`)
  }
}

/** The longest text a `text` field holds (D18). */
export const TEXT_MAX = 10_000
/** The longest key (before the suffix) or field name (D9). */
export const NAME_MAX = 40
/** The suffix every custom object key carries (D9). */
export const KEY_SUFFIX = '__c'
const LABEL_MAX = 200
const DESCRIPTION_MAX = 2_000
const ENUM_VALUE_MAX = 100

/**
 * D19: a declaration may not name a bookkeeping column or any reserved name. The bookkeeping columns, `additional_props` ([[CORE318]]), the list parameters (`after`, `limit`, `sort`, `order`, `q`, `tag`, `tag_id`)
 * and the CLI's reserved flags (`data`, `all`, `refresh`, `profile`, `server`, `output`, `help`): a field named like one would make the list command impossible to derive.
 */
export const RESERVED_NAMES: readonly string[] = [
  'id',
  'organization_id',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'additional_props',
  'after',
  'limit',
  'sort',
  'order',
  'q',
  'tag',
  'tag_id',
  'data',
  'all',
  'refresh',
  'profile',
  'server',
  'output',
  'help',
]

const NAME_SHAPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

function checkKey(key: string): void {
  const fail = (rule: string, message: string): never => {
    throw new DeclarationError(rule, message, key)
  }
  if (!key.endsWith(KEY_SUFFIX)) fail('key_suffix', `a custom object's key ends in ${KEY_SUFFIX}`)
  const base = key.slice(0, -KEY_SUFFIX.length)
  if (base.includes('__')) fail('key_double_underscore', 'a key has no double underscore before its suffix')
  if (!NAME_SHAPE.test(base)) fail('key_shape', 'a key is lowercase snake_case starting with a letter')
  if (base.length > NAME_MAX) fail('key_length', `a key is at most ${NAME_MAX} characters before ${KEY_SUFFIX}`)
}

/** A refinement's refusal: a custom issue carrying the rule code, which `parseObjectDeclaration` reads back. */
const refuse = (ctx: z.RefinementCtx, rule: string, message: string, path: (string | number)[] = []) =>
  ctx.addIssue({ code: 'custom', message, params: { rule }, path })

/** One field (D18, P1). The structure is zod's; each rule that has a name is a refinement, in the order a person would fix them. */
const fieldSchema = z
  .strictObject({
    kind: z.unknown().optional(),
    label: z.string().max(LABEL_MAX).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    values: z.unknown().optional(),
    unique: z.boolean().optional(),
    target: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === 'reference') return refuse(ctx, 'reference_later', 'the reference kind arrives in a later release')
    if (typeof f.kind !== 'string' || !(FIELD_KINDS as readonly string[]).includes(f.kind))
      return refuse(ctx, 'unknown_kind', `kind is one of ${FIELD_KINDS.join(', ')}`)
    const kind = f.kind as FieldKind
    if (f.unique === true) return refuse(ctx, 'unique_later', 'unique fields arrive in a later release')
    if (f.target !== undefined)
      return refuse(ctx, 'unknown_property', '"target" belongs to the reference kind, which arrives in a later release')
    if (kind !== 'enum') {
      if (f.values !== undefined) return refuse(ctx, 'values_not_enum', 'values belong to an enum field')
    } else {
      if (!Array.isArray(f.values) || f.values.length === 0)
        return refuse(ctx, 'values_empty', 'an enum field lists its values')
      if (f.values.some((v) => typeof v !== 'string' || v.length === 0 || v.length > ENUM_VALUE_MAX))
        return refuse(ctx, 'values_invalid', `an enum value is a string of 1 to ${ENUM_VALUE_MAX} characters`)
      if (new Set(f.values).size !== f.values.length)
        return refuse(ctx, 'values_repeated', 'an enum lists each value once')
    }
    if (f.default !== undefined) {
      const d = f.default
      if (kind === 'timestamp') return refuse(ctx, 'default_on_timestamp', 'a timestamp has no default')
      const fits =
        kind === 'text'
          ? typeof d === 'string' && d.length <= TEXT_MAX
          : kind === 'integer'
            ? typeof d === 'number' && Number.isSafeInteger(d)
            : kind === 'boolean'
              ? typeof d === 'boolean'
              : typeof d === 'string' && (f.values as string[]).includes(d)
      if (!fits) return refuse(ctx, 'default_invalid', `the default does not fit a ${kind} field`)
    }
  })

/** The fields of an object: each name is checked (D9, D19) before its declaration. */
const fieldsSchema = z.record(z.string(), fieldSchema).superRefine((fields, ctx) => {
  for (const name of Object.keys(fields)) {
    const at = [name]
    if (name.includes('__')) refuse(ctx, 'field_name_double_underscore', 'a field name has no double underscore', at)
    else if (!NAME_SHAPE.test(name))
      refuse(ctx, 'field_name_shape', 'a field name is lowercase snake_case starting with a letter', at)
    else if (name.length > NAME_MAX)
      refuse(ctx, 'field_name_length', `a field name is at most ${NAME_MAX} characters`, at)
    else if (RESERVED_NAMES.includes(name))
      refuse(ctx, 'reserved_name', `"${name}" is reserved (a bookkeeping column, a list parameter or a CLI flag)`, at)
  }
})

/** The declaration of one object. Its JSON Schema is `z.toJSONSchema(objectSchema)` when the extensions file publishes one (a later cycle's). */
export const objectSchema = z.strictObject({
  label: z.string().max(LABEL_MAX).optional(),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  fields: fieldsSchema,
})

/** The rule of the first issue zod found, by its code (a structural failure has no custom rule of its own). */
function ruleOf(issue: z.core.$ZodIssue, input: unknown): string {
  if (issue.code === 'custom') return String((issue.params as { rule?: string } | undefined)?.rule ?? 'invalid')
  if (issue.code === 'unrecognized_keys') return 'unknown_property'
  if (issue.code === 'invalid_type') {
    if (issue.path.length === 0) return 'not_an_object'
    if (issue.path.length === 1 && issue.path[0] === 'fields') return 'fields_missing'
    if (issue.path[0] === 'fields' && issue.path.length === 2) return 'not_an_object'
  }
  void input
  return 'invalid_type'
}

/** Validates one object's declaration under `key` ([[CORE315]] D6, D9, D18, D19, P1): returns it normalised, or throws a `DeclarationError` naming the rule. */
export function parseObjectDeclaration(key: string, input: unknown): ObjectDeclaration {
  checkKey(key)
  const parsed = objectSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new DeclarationError(ruleOf(issue, input), issue.message, [key, ...issue.path.map(String)].join('.'))
  }
  const d = parsed.data
  const fields: Record<string, FieldDeclaration> = {}
  for (const [name, f] of Object.entries(d.fields)) {
    const { kind, unique: _unique, target: _target, ...rest } = f
    fields[name] = { kind: kind as FieldKind, ...rest } as FieldDeclaration
  }
  return {
    ...(d.label !== undefined ? { label: d.label } : {}),
    ...(d.description !== undefined ? { description: d.description } : {}),
    fields,
  }
}

/** Validates a map of declarations by key (P2: the file's envelope is a later cycle's). Each key is unique by being a key of the map. */
export function parseObjectDeclarations(input: unknown): Record<string, ObjectDeclaration> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new DeclarationError('not_an_object', 'the objects are a map from key to declaration')
  const out: Record<string, ObjectDeclaration> = {}
  for (const [key, declaration] of Object.entries(input)) out[key] = parseObjectDeclaration(key, declaration)
  return out
}
