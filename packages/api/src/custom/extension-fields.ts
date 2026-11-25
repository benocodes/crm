// Extension fields served on a built-in ([[CORE315]] D1, D8, D18, D20, D21, D22, D23, D33; [[CORE559]] P1-P5). `extendDefinition` is the one place a built-in's definition meets its `extend` entry: the same field kinds as a
// custom object's, mapped onto the same schemas, with the built-in rule of D8: a column added to a table that has rows is nullable unless a constant default fills it, so a required field with no default is enforced on
// WRITE (create, and update to null), never on read. The definition carries its own column kinds (core plus `__c`), so no generic path reads `COLUMN_KINDS` for it.
import { z } from 'zod'
import { COLUMN_KINDS, type ColumnKind } from '@vibase/storage'
import type { PreparedResource, ReferenceTarget } from '../storage/definition.js'
import type { FieldDeclaration } from './declaration.js'
import { KIND_OF, inputOf, recordOf, referenceSpec, uniqueConflicts } from './resource.js'

/** What a built-in's definition says of one extension field, for `schema.get` (kind, label, description, enum values; a reference's target is read from the live foreign key). */
export type ExtensionFields = Readonly<Record<string, FieldDeclaration>>

/** The value a column holds is non-null only when the field is required AND a constant default fills it (the DDL of [[CORE555]] P3). */
const notNull = (f: FieldDeclaration): boolean => f.required === true && f.default !== undefined

/** D33: an extension field that is neither a reference nor unique has no index of its own, so `eq` reads the organisation's live rows. */
const COST =
  "no (organization_id, column, id) index (D33): only reference and unique extension fields are indexed, so eq reads the organisation's live rows"

export function extendShapes(fields: ExtensionFields) {
  const names = Object.keys(fields)
  const record = Object.fromEntries(names.map((n) => [n, recordOf(fields[n]!, notNull(fields[n]!))]))
  // Create: required with no default must be given (non-null); a default is applied when the field is absent; any other is optional and may be null (D8).
  const create = Object.fromEntries(
    names.map((n) => {
      const f = fields[n]!
      const value = inputOf(f)
      if (f.default !== undefined) return [n, (f.required === true ? value : value.nullable()).default(f.default)]
      return [n, f.required === true ? value : value.nullable().optional()]
    }),
  )
  // Update: every field optional, no defaults (a patch that does not name a field never resets it); a required field refuses null.
  const update = Object.fromEntries(
    names.map((n) => {
      const f = fields[n]!
      const value = inputOf(f)
      return [n, (f.required === true ? value : value.nullable()).optional()]
    }),
  )
  return { record, create, update }
}

/**
 * The definition with its extension fields (a pure function of the definition and the fields, no module state). With none, the same definition: a deployment without an `extend` serves exactly what it served. The record,
 * create and update schemas gain the fields; the definition gains its own column kinds, the references and unique checks of D21 and D22, and the stated cost of D33.
 */
export function extendDefinition<D extends PreparedResource>(def: D, fields: ExtensionFields | undefined): D {
  const names = Object.keys(fields ?? {})
  if (!fields || names.length === 0) return def
  const shapes = extendShapes(fields)
  const references = Object.fromEntries(
    names.flatMap((n) => (fields[n]!.kind === 'reference' ? [[n, referenceSpec(fields[n]!)] as const] : [])),
  ) as Record<string, ReferenceTarget>
  const uniques = names.filter((n) => fields[n]!.unique === true)
  const extConflicts = uniques.length > 0 ? uniqueConflicts(def.table, uniques) : undefined
  const base = def.conflicts
  const plain = names.filter((n) => fields[n]!.kind !== 'reference' && fields[n]!.unique !== true)
  const kinds: Record<string, ColumnKind> = {
    ...(COLUMN_KINDS[def.table] as Record<string, ColumnKind>),
    ...Object.fromEntries(names.map((n) => [n, KIND_OF[fields[n]!.kind]])),
  }
  return {
    ...def,
    record: (def.record as unknown as z.ZodObject).extend(shapes.record) as unknown as D['record'],
    create: def.create?.extend(shapes.create),
    update: def.update?.extend(shapes.update),
    columnKinds: kinds,
    references: { ...def.references, ...references } as D['references'],
    ...(base || extConflicts
      ? { conflicts: ((c: never) => [...(base?.(c) ?? []), ...(extConflicts?.(c) ?? [])]) as unknown as D['conflicts'] }
      : {}),
    statedFilterCosts: [...(def.statedFilterCosts ?? []), ...plain.map((filter) => ({ filter, reason: COST }))],
    extensionFields: fields,
  }
}
