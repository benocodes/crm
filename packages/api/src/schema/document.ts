import { z } from 'zod'

// API63 D10, D11: the response of `schema.get`. Field order here is the wire order.
const reference = z.object({ table: z.string(), column: z.string() })

export const schemaColumn = z.object({
  name: z.string(),
  type: z.string().describe('The declared SQL type, as the database reports it (TEXT, INTEGER).'),
  kind: z.string().nullable().describe('The logical kind (see `kinds`), or null if the code does not know the column.'),
  nullable: z.boolean(),
  primary_key: z.boolean(),
  default: z.string().nullable().describe('The declared default expression, or null.'),
  label: z.string(),
  description: z.string().nullable(),
  values: z
    .array(z.string())
    .nullable()
    .describe('The allowed values when the record schema declares an enum for the field.'),
  exposed: z.boolean().describe("True when the column is a field of the API record of the table's resource."),
  references: reference.nullable().describe('The table and primary-key column this column points at.'),
})

export const schemaDerived = z.object({
  name: z.string(),
  kind: z.string().describe('The logical kind of the value (see `kinds`).'),
  nullable: z.boolean(),
  writable: z.literal(false).describe('Derived fields are computed when the record is read and can never be written.'),
  label: z.string(),
  description: z.string().nullable(),
  requires: z
    .string()
    .nullable()
    .describe('The scope needed to see the field (it is absent from the record without it), or null.'),
  filters: z.array(z.string()).describe('The list filters on this field.'),
  sortable: z.boolean().describe('Whether the list can be sorted by this field.'),
})

export const schemaForeignKey = z.object({
  columns: z.array(z.string()),
  references: z.object({ table: z.string(), columns: z.array(z.string()) }),
  on_delete: z.string(),
})

// [[CORE170]] D10, D16, D17: one value `sort` accepts on the resource's list. No `requires`: a derived sort's scope is on its `derived` entry.
export const schemaSort = z.object({
  name: z.string().describe("A value the list's `sort` parameter accepts: a column of the record or a derived field."),
  kind: z.string().describe('The logical kind of the sort value (see `kinds`): timestamp, uuid, text or integer.'),
  indexed: z
    .boolean()
    .describe(
      "True when an index serves this sort. False is a stated cost: the database sorts the organisation's live rows in a temporary b-tree.",
    ),
})

// [[CORE201]] D11, D12: one filter of the resource's list. Column filters take the grammar; custom filters take one bare value.
export const schemaFilter = z.object({
  name: z.string().describe('The query parameter: a column of the record, or a custom filter.'),
  custom: z
    .boolean()
    .describe(
      'True for a custom filter (a tag by name, an association, a derived field): one bare value, no operators.',
    ),
  kind: z
    .string()
    .nullable()
    .describe(
      'The logical kind of a column filter (see `kinds`), which decides its operators; null for a custom filter.',
    ),
  operators: z
    .array(z.string())
    .describe(
      'The operators a column filter accepts, as [not.]<operator>.<value>; a bare value means eq. Empty for a custom filter.',
    ),
  indexed: z
    .boolean()
    .nullable()
    .describe(
      "True when an index serves `eq` on this column. False is a stated cost: the database reads the organisation's live rows. neq, not., like and ilike read every live row whatever this says. Null for a custom filter, which is not measured.",
    ),
  description: z.string(),
})

// [[CORE202]] D19: how an aggregatable list aggregates; the field lists are D14's kind table applied to the record, `money` is D15's declaration.
export const schemaAggregate = z.object({
  sum: z.array(z.string()).describe('The fields `sum` takes (integers).'),
  avg: z.array(z.string()).describe('The fields `avg` takes (integers).'),
  min: z.array(z.string()).describe('The fields `min` takes (integers, timestamps and text).'),
  max: z.array(z.string()).describe('The fields `max` takes (integers, timestamps and text).'),
  money: z
    .record(z.string(), z.string())
    .describe(
      'Money fields, each with the column that holds its currency: a function over one is refused when the matching amounts are in more than one currency.',
    ),
})

// [[API514]] D9, D10: the record fields a caller sees only with a scope (they are absent from the record without it, and a filter or sort on them is refused).
export const schemaContent = z.object({
  fields: z.array(z.string()).describe('The record fields that are present only with `requires`.'),
  requires: z.string().describe('The scope that reveals the fields. Without it they are absent, not null.'),
})

export const schemaResource = z.object({
  name: z.string(),
  surface: z.enum(['api', 'meta']),
  path: z.string().describe('The full path of the collection, for example /api/v1/tasks.'),
  operations: z.array(z.string()),
  read_scope: z.string(),
  write_scope: z.string().nullable(),
  sorts: z
    .array(schemaSort)
    .describe(
      'The sorts the list accepts, in the order it accepts them (convention first, then the natural fields); empty when the list takes no `sort`.',
    ),
  filters: z
    .array(schemaFilter)
    .describe(
      'The filters the list accepts: column filters in record field order, then custom filters in declaration order.',
    ),
  content: schemaContent
    .optional()
    .describe('The record fields hidden from a caller without a scope; absent when the record has none.'),
  aggregate: schemaAggregate
    .nullable()
    .describe('How `<list>.aggregate` aggregates this list, or null when the list has no aggregate operation.'),
})

export const schemaTable = z.object({
  name: z.string(),
  origin: z
    .enum(['built_in', 'custom'])
    .describe(
      'custom for the table of a custom object (declared, or archived when no declaration describes it), built_in otherwise.',
    ),
  archived: z
    .boolean()
    .describe(
      'True for a custom table no declaration describes: its rows are kept, nothing is served for it, and its columns are not exposed. Always false for a built-in table.',
    ),
  label: z.string(),
  description: z.string().nullable(),
  associable: z.boolean(),
  resource: schemaResource.nullable(),
  columns: z.array(schemaColumn),
  derived: z.array(schemaDerived).describe('Record fields computed from other tables when read; not columns.'),
  foreign_keys: z.array(schemaForeignKey),
})

export const schemaDocument = z.object({
  engine: z.literal('d1'),
  kinds: z.record(z.string(), z.string()).describe('How each logical kind is stored.'),
  tables: z.array(schemaTable),
  associations: z.object({
    table: z.string(),
    relations: z.array(z.string()),
    associable: z.array(z.string()),
    description: z.string(),
  }),
})
export type SchemaDocument = z.infer<typeof schemaDocument>
export type SchemaTable = z.infer<typeof schemaTable>
