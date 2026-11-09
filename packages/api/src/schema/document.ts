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
  values: z.array(z.string()).nullable().describe('The allowed values when the record schema declares an enum for the field.'),
  exposed: z.boolean().describe('True when the column is a field of the API record of the table\'s resource.'),
  references: reference.nullable().describe('The table and primary-key column this column points at.'),
})

export const schemaDerived = z.object({
  name: z.string(),
  kind: z.string().describe('The logical kind of the value (see `kinds`).'),
  nullable: z.boolean(),
  writable: z.literal(false).describe('Derived fields are computed when the record is read and can never be written.'),
  label: z.string(),
  description: z.string().nullable(),
  requires: z.string().nullable().describe('The scope needed to see the field (it is absent from the record without it), or null.'),
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
  name: z.string().describe('A value the list\'s `sort` parameter accepts: a column of the record or a derived field.'),
  kind: z.string().describe('The logical kind of the sort value (see `kinds`): timestamp, uuid, text or integer.'),
  indexed: z.boolean().describe('True when an index serves this sort. False is a stated cost: the database sorts the organisation\'s live rows in a temporary b-tree.'),
})

export const schemaResource = z.object({
  name: z.string(),
  surface: z.enum(['api', 'meta']),
  path: z.string().describe('The full path of the collection, for example /api/v1/tasks.'),
  operations: z.array(z.string()),
  read_scope: z.string(),
  write_scope: z.string().nullable(),
  sorts: z.array(schemaSort).describe('The sorts the list accepts, in the order it accepts them (convention first, then the natural fields); empty when the list takes no `sort`.'),
})

export const schemaTable = z.object({
  name: z.string(),
  origin: z.literal('built_in'),
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
