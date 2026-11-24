import { z } from 'zod'
import type { ColumnKind } from '@vibase/storage'
import type { FieldDeclaration } from '../custom/declaration.js'
import { additionalPropsInput, additionalPropsRecord } from '../storage/additional-props.js'

// [[CORE315]] D1, D2, D6, [[CORE554]]: a built-in object declared once. A declaration is plain data plus a little code: the record, create and update
// schemas, the column filter options, the sorts, the column kinds and the `schema.get` text of the table are all derived from it (the builders below), so
// they cannot drift apart. `BuiltInField` is a code-only superset of the extensions file's `FieldDeclaration` (P1, row 554.2): everything a file may say a
// field is, plus the properties only a core field has, which may carry code (D6). The file's validator and its published JSON Schema do not know them.
// D15: there is no presentation metadata here: no order, view, icon or layout key (a test holds the key set).

/** How a text column is read beyond its kind: a UUID, a calendar date, or the `additional_props` property bag (a JSON column). */
export type BuiltInFormat = 'uuid' | 'date' | 'bag'

/** Core-only: how a field takes part in create and update. `normal` is both; `create_only` is create only (a later update is refused with `updateRefusal`); `system` is never input. */
export type BuiltInInput = 'normal' | 'create_only' | 'system'

export interface BuiltInField extends FieldDeclaration {
  /** The column allows null, and so do the record and the input. Default false (the column is NOT NULL). */
  nullable?: boolean
  /** Default `normal`. */
  input?: BuiltInInput
  /** The refusal text when an update names a `create_only` (or system) field. */
  updateRefusal?: string
  /** False: a column that is not part of the record (`deleted_at`). */
  inRecord?: false
  /** A record field that is no column: computed on read, optional in the record, never input. Its kind and `values` type it; `apiDescription` documents it. */
  derived?: true
  format?: BuiltInFormat
  /** Text input: trim before checking. */
  trim?: boolean
  minLength?: number
  maxLength?: number
  /** Integer input bounds. */
  min?: number
  max?: number
  /** Text input: a pattern and the message its refusal carries. */
  pattern?: { regex: RegExp; message: string }
  /** The text OpenAPI and MCP show for the field (`.describe`), where it differs from the `schema.get` `description`; a derived field's record schema carries it. */
  apiDescription?: string
  /** The options the column filter grammar takes for this column (an operand schema, a normaliser). */
  filter?: { schema?: z.ZodType; normalize?: (value: unknown) => unknown }
  /** A sentence appended to the generated filter description. */
  filterNote?: string
}

export interface BuiltInDeclaration<N extends string = string> {
  /** The table (and the resource's name). */
  table: N
  label: string
  description: string
  /** In record order. Shared columns are spread in from `IDENTITY_FIELDS` and `BOOKKEEPING_FIELDS`. */
  fields: Readonly<Record<string, BuiltInField>>
  /** The columns (or derived fields) the list sorts by, besides the convention (`id`, `created_at`, `updated_at`), in the order the list shows them. */
  sorts: readonly string[]
  /**
   * The order the list shows its option-carrying column filters in, where it is not the field order (the wire lists them in this order, and a
   * reorder would be a wire change). Names exactly the fields that carry `filter`.
   */
  filterOrder?: readonly string[]
}

/** The shared first columns of a record (no text of their own: `CATALOG.common` describes them). */
export const IDENTITY_FIELDS = {
  id: { kind: 'text', format: 'uuid', input: 'system' },
  organization_id: { kind: 'reference', target: 'organizations', input: 'system' },
} as const satisfies Record<string, BuiltInField>

/** The shared bookkeeping columns, after a table's own fields. `deleted_at` is a column of the table and no field of the record. */
export const BOOKKEEPING_FIELDS = {
  additional_props: { kind: 'text', format: 'bag', required: false },
  created_by: { kind: 'reference', target: 'principals', input: 'system' },
  created_at: { kind: 'timestamp', input: 'system' },
  updated_at: { kind: 'timestamp', input: 'system' },
  deleted_at: { kind: 'timestamp', input: 'system', nullable: true, inRecord: false },
} as const satisfies Record<string, BuiltInField>

const entries = (d: BuiltInDeclaration) => Object.entries(d.fields)
const inputOf = (f: BuiltInField): BuiltInInput => (f.derived ? 'system' : (f.input ?? 'normal'))
const isColumn = (f: BuiltInField) => f.derived !== true

/** The storage kind a field's column is bound, cast and read as. */
export function columnKindOf(f: BuiltInField): ColumnKind {
  if (f.format === 'bag') return 'json'
  if (f.format === 'uuid' || f.kind === 'reference') return 'uuid'
  if (f.kind === 'integer') return 'integer'
  if (f.kind === 'timestamp') return 'timestamp'
  if (f.kind === 'boolean') return 'boolean'
  return 'text'
}

/** The SQLite storage type of a field's column (what the migrations declare). */
export function storageTypeOf(f: BuiltInField): 'TEXT' | 'INTEGER' {
  return f.kind === 'integer' || f.kind === 'boolean' ? 'INTEGER' : 'TEXT'
}

/** Every column of the table with its storage kind: what `COLUMN_KINDS[table]` holds (P3, row 554.4). */
export function columnKinds(d: BuiltInDeclaration): Record<string, ColumnKind> {
  return Object.fromEntries(
    entries(d)
      .filter(([, f]) => isColumn(f))
      .map(([n, f]) => [n, columnKindOf(f)]),
  )
}

const nullable = (f: BuiltInField, s: z.ZodType): z.ZodType => (f.nullable ? s.nullable() : s)

function recordField(f: BuiltInField): z.ZodType {
  if (f.format === 'bag') return additionalPropsRecord
  let s: z.ZodType
  if (f.kind === 'enum') s = z.enum(f.values as [string, ...string[]])
  else if (f.format === 'uuid' || f.kind === 'reference') s = z.uuid()
  else if (f.kind === 'integer') s = z.number().int()
  else s = z.string()
  s = nullable(f, s)
  if (f.derived) {
    // A derived field is optional in the record (present only for a caller who may read it); a nullable one reads null when there is nothing.
    s = s.optional()
    if (f.apiDescription) s = s.describe(f.apiDescription)
  }
  return s
}

/** The static shape of a record schema: one zod type per field of the record type `R`. */
export type RecordShapeOf<R> = { [K in keyof R]-?: z.ZodType<R[K]> }

/**
 * The record schema: every field a record shows, in declaration order. The declaration builds the zod types at run time; `R` is the record's
 * hand-written type (`ContactRecord`), which types the result, so the definition layer still checks each field against its column's type (`RecordShape`).
 */
export function recordSchema<R>(d: BuiltInDeclaration): z.ZodObject<RecordShapeOf<R>> {
  const shape = Object.fromEntries(
    entries(d)
      .filter(([, f]) => f.inRecord !== false)
      .map(([n, f]) => [n, recordField(f)]),
  )
  return z.object(shape) as unknown as z.ZodObject<RecordShapeOf<R>>
}

function inputField(f: BuiltInField): z.ZodType {
  if (f.format === 'bag') return additionalPropsInput.optional()
  let s: z.ZodType
  if (f.kind === 'enum') s = z.enum(f.values as [string, ...string[]])
  else if (f.format === 'uuid' || f.kind === 'reference') s = z.uuid()
  else if (f.format === 'date') s = z.iso.date()
  else if (f.kind === 'timestamp') s = z.iso.datetime({ offset: true })
  else if (f.kind === 'integer') {
    let n = z.number().int()
    if (f.min !== undefined) n = n.min(f.min)
    if (f.max !== undefined) n = n.max(f.max)
    s = n
  } else {
    let t = z.string()
    if (f.trim) t = t.trim()
    if (f.minLength !== undefined) t = t.min(f.minLength)
    if (f.maxLength !== undefined) t = t.max(f.maxLength)
    if (f.pattern) t = t.regex(f.pattern.regex, f.pattern.message)
    s = t
  }
  s = nullable(f, s)
  if (!f.required) s = s.optional()
  if (f.apiDescription) s = s.describe(f.apiDescription)
  return s
}

/** The create schema: the normal fields in declaration order, then the create-only ones (a deal's stage), strict. */
export function createSchema(d: BuiltInDeclaration) {
  const of = (which: BuiltInInput) =>
    entries(d)
      .filter(([, f]) => inputOf(f) === which)
      .map(([n, f]) => [n, inputField(f)] as const)
  return z.strictObject(Object.fromEntries([...of('normal'), ...of('create_only')]))
}

/** The update schema: the normal fields only, each optional, strict. */
export function updateSchema(d: BuiltInDeclaration) {
  return z
    .strictObject(
      Object.fromEntries(
        entries(d)
          .filter(([, f]) => inputOf(f) === 'normal')
          .map(([n, f]) => [n, inputField(f)]),
      ),
    )
    .partial()
}

/** The refusals of an update that names a field it may not change, by field (`createOnly` of the resource definition). */
export function updateRefusals(d: BuiltInDeclaration): Record<string, string> {
  return Object.fromEntries(entries(d).flatMap(([n, f]) => (f.updateRefusal ? [[n, f.updateRefusal]] : [])))
}

/** The per-column options of the column filter grammar (`filters` of the resource definition), in `filterOrder` or field order. */
export function filterOptions(d: BuiltInDeclaration): Record<string, NonNullable<BuiltInField['filter']>> {
  const own = entries(d).flatMap(([n, f]) => (f.filter ? [n] : []))
  const order = d.filterOrder ?? own
  if (order.length !== own.length || own.some((n) => !order.includes(n)))
    throw new Error(`${d.table}: filterOrder must name exactly the fields that carry a filter (${own.join(', ')})`)
  return Object.fromEntries(order.map((n) => [n, d.fields[n]!.filter!]))
}

/** The sentences appended to a column's generated filter description. */
export function filterNotes(d: BuiltInDeclaration): Record<string, string> {
  return Object.fromEntries(entries(d).flatMap(([n, f]) => (f.filterNote ? [[n, f.filterNote]] : [])))
}

/** The text the `schema.get` catalog holds for the table (P4, row 554.5): the declaration's labels and descriptions, in the catalog's own shape. */
export function catalogText(d: BuiltInDeclaration) {
  const text = (f: BuiltInField) => (f.label ? { label: f.label, description: f.description! } : f.description!)
  const described = entries(d).filter(([, f]) => f.description !== undefined)
  const derived = described.filter(([, f]) => f.derived)
  return {
    label: d.label,
    description: d.description,
    columns: Object.fromEntries(described.filter(([, f]) => !f.derived).map(([n, f]) => [n, text(f)])),
    ...(derived.length > 0 ? { derived: Object.fromEntries(derived.map(([n, f]) => [n, text(f)])) } : {}),
  }
}
