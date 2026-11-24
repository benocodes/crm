// The one constructor of a custom object's definition ([[CORE315]] D23). A declaration (plain data, `declaration.ts`) becomes a `PreparedResource` the generic layer serves like any other: full CRUD with soft delete, associable, its writes
// proposable, events named after it (`<key>__c.created|updated|deleted`), `d1Only`. The definition carries its own column kinds, so no generic path reads a module constant for it: the storage layer's `COLUMN_KINDS` never gains an entry.
import { z } from 'zod'
import type { ColumnKind, Table } from '@vibase/storage'
import type { AnyResource } from '../registry.js'
import type { PreparedResource } from '../storage/definition.js'
import { parseObjectDeclaration, TEXT_MAX, type FieldDeclaration, type ObjectDeclaration } from './declaration.js'

/** D18: each field kind is read, bound and rendered as an existing storage kind (an enum is text). */
const KIND_OF: Record<FieldDeclaration['kind'], ColumnKind> = {
  text: 'text',
  integer: 'integer',
  boolean: 'boolean',
  timestamp: 'timestamp',
  enum: 'text',
}

/** The value a caller may write for a field (D18, D20): an enum accepts only its declared values here, and nowhere else, so a stored retired value still reads. */
function inputOf(f: FieldDeclaration): z.ZodType {
  switch (f.kind) {
    case 'text':
      return z.string().max(TEXT_MAX)
    case 'integer':
      return z.int()
    case 'boolean':
      return z.boolean()
    case 'timestamp':
      return z.iso.datetime({ offset: true })
    case 'enum':
      return z.enum(f.values as [string, ...string[]])
  }
}

/** What a stored value reads as: an enum is a plain string, so a value that was later removed from the declaration still parses. */
function recordOf(f: FieldDeclaration): z.ZodType {
  const base = f.kind === 'integer' ? z.number() : f.kind === 'boolean' ? z.boolean() : z.string()
  return f.required === true ? base : base.nullable()
}

/**
 * Builds the definition of the custom object `key` from its declaration. The declaration is validated again here (a definition cannot be built from a broken one), so the constructor is also the guard of a caller that
 * hands it data it did not parse. The one cast of this module: a custom table is not a member of the CRM's `Table` union, which is a compile-time view of `COLUMN_KINDS`; the definition's `columnKinds` is what every
 * generic path reads instead.
 */
export function defineCustomObject(key: string, declaration: ObjectDeclaration): AnyResource {
  const decl = parseObjectDeclaration(key, declaration)
  const names = Object.keys(decl.fields)

  const columnKinds: Record<string, ColumnKind> = {
    id: 'uuid',
    organization_id: 'uuid',
    created_by: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    deleted_at: 'timestamp',
    ...Object.fromEntries(names.map((n) => [n, KIND_OF[decl.fields[n]!.kind]])),
  }

  const record = z.object({
    id: z.uuid(),
    organization_id: z.uuid(),
    created_by: z.uuid(),
    created_at: z.string(),
    updated_at: z.string(),
    ...Object.fromEntries(names.map((n) => [n, recordOf(decl.fields[n]!)])),
  })

  // Create: a required field with no default must be given; a field with a default takes it when absent; any other is optional and may be null.
  const createShape = Object.fromEntries(
    names.map((n) => {
      const f = decl.fields[n]!
      const value = inputOf(f)
      if (f.default !== undefined) return [n, (f.required === true ? value : value.nullable()).default(f.default)]
      return [n, f.required === true ? value : value.nullable().optional()]
    }),
  )
  // Update: every field optional and no defaults, so a patch that does not name a field never resets it.
  const updateShape = Object.fromEntries(
    names.map((n) => {
      const f = decl.fields[n]!
      const value = inputOf(f)
      return [n, (f.required === true ? value : value.nullable()).optional()]
    }),
  )

  const def: PreparedResource = {
    surface: 'api',
    name: key,
    eventName: key,
    table: key as unknown as Table,
    columnKinds,
    d1Only: true,
    associable: true,
    record: record as unknown as PreparedResource['record'],
    create: z.strictObject(createShape),
    update: z.strictObject(updateShape),
  }
  return def
}
