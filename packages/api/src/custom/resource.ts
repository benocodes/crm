// The one constructor of a custom object's definition ([[CORE315]] D23). A declaration (plain data, `declaration.ts`) becomes a `PreparedResource` the generic layer serves like any other: full CRUD with soft delete, associable, its writes
// proposable, events named after it (`<key>__c.created|updated|deleted`), `d1Only`. The definition carries its own column kinds, so no generic path reads a module constant for it: the storage layer's `COLUMN_KINDS` never gains an entry.
import { z } from 'zod'
import { readMaybe, type ColumnKind, type Table } from '@vibase/storage'
import type { Kysely } from 'kysely'
import { ApiError } from '../errors.js'
import type { AnyResource } from '../registry.js'
import { additionalPropsInput, additionalPropsRecord } from '../storage/additional-props.js'
import { withPropertyBag } from '../storage/bag-filter.js'
import { withAggregate } from '../storage/aggregate.js'
import { withColumnFilters } from '../storage/column-filters.js'
import type { Conflict, PreparedResource, ReferenceTarget } from '../storage/definition.js'
import {
  KEY_SUFFIX,
  parseObjectDeclaration,
  TEXT_MAX,
  type FieldDeclaration,
  type ObjectDeclaration,
} from './declaration.js'

/** D18: each field kind is read, bound and rendered as an existing storage kind (an enum is text). */
export const KIND_OF: Record<FieldDeclaration['kind'], ColumnKind> = {
  text: 'text',
  integer: 'integer',
  boolean: 'boolean',
  timestamp: 'timestamp',
  enum: 'text',
  reference: 'uuid',
}

/** The value a caller may write for a field (D18, D20): an enum accepts only its declared values here, and nowhere else, so a stored retired value still reads. */
export function inputOf(f: FieldDeclaration): z.ZodType {
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
    case 'reference':
      return z.uuid()
  }
}

/** What a stored value reads as: an enum is a plain string, so a value that was later removed from the declaration still parses. */
export function recordOf(f: FieldDeclaration, notNull = f.required === true): z.ZodType {
  const base = f.kind === 'integer' ? z.number() : f.kind === 'boolean' ? z.boolean() : z.string()
  return notNull ? base : base.nullable()
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
    additional_props: 'json',
    ...Object.fromEntries(names.map((n) => [n, KIND_OF[decl.fields[n]!.kind]])),
  }

  const record = z.object({
    id: z.uuid(),
    organization_id: z.uuid(),
    created_by: z.uuid(),
    created_at: z.string(),
    updated_at: z.string(),
    additional_props: additionalPropsRecord,
    ...Object.fromEntries(names.map((n) => [n, recordOf(decl.fields[n]!)])),
  })

  // Create: a required field with no default must be given; a field with a default takes it when absent; any other is optional and may be null.
  const createShape = {
    ...Object.fromEntries(
      names.map((n) => {
        const f = decl.fields[n]!
        const value = inputOf(f)
        if (f.default !== undefined) return [n, (f.required === true ? value : value.nullable()).default(f.default)]
        return [n, f.required === true ? value : value.nullable().optional()]
      }),
    ),
    additional_props: additionalPropsInput.optional(),
  }
  // Update: every field optional and no defaults, so a patch that does not name a field never resets it.
  const updateShape = {
    ...Object.fromEntries(
      names.map((n) => {
        const f = decl.fields[n]!
        const value = inputOf(f)
        return [n, (f.required === true ? value : value.nullable()).optional()]
      }),
    ),
    additional_props: additionalPropsInput.optional(),
  }

  // D21: a reference is checked by the generic reference hook (plan read, commit guard and approval all use it): live for a target that soft-deletes, existence only for principals (P3).
  const references = Object.fromEntries(
    names.flatMap((n) => {
      const f = decl.fields[n]!
      return f.kind === 'reference' ? [[n, referenceSpec(f)] as const] : []
    }),
  )
  const uniques = names.filter((n) => decl.fields[n]!.unique === true)

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
    declaration: decl,
    statedFilterCosts: statedFilterCosts(
      names.filter((n) => decl.fields[n]!.kind !== 'reference' && decl.fields[n]!.unique !== true),
    ),
    ...(Object.keys(references).length > 0 ? { references: references as PreparedResource['references'] } : {}),
    ...(uniques.length > 0 ? { conflicts: uniqueConflicts(key, uniques) } : {}),
  }
  // D33: every record field is a column filter of its kind (a reference as a uuid); the custom list declares no sort.
  // [[CORE549]] D10: the bag filter, a custom filter named `additional_props`.
  return withPropertyBag(withAggregate(withColumnFilters(def))) as unknown as AnyResource
}

/** D21: what a reference field points at: a live row of the target (a principal needs only to exist, P3), or a custom object's. */
export function referenceSpec(f: FieldDeclaration): ReferenceTarget {
  const target = f.target!
  return target.endsWith(KEY_SUFFIX)
    ? { table: target as `${string}__c`, live: true, custom: true }
    : target === 'principals'
      ? { table: 'principals' }
      : { table: target as 'contacts' | 'companies' | 'deals' | 'tasks', live: true }
}

/** The columns whose `eq` is not served by an index (P1): the bookkeeping columns but `id`, and every declared field that is neither a reference nor unique. */
function statedFilterCosts(plain: string[]): { filter: string; reason: string }[] {
  const reason =
    "no (organization_id, column, id) index (D12, P1): only reference and unique fields of a custom object are indexed, so eq reads the organisation's live rows"
  return ['created_by', 'created_at', 'updated_at', ...plain].map((filter) => ({ filter, reason }))
}

/** D22: a live row of the same organisation holding the value refuses the write in the plan, naming it (`409 value_exists`); the partial unique index is the commit-time backstop (a race answers `409 conflict`, P4). */
export function uniqueConflicts(key: string, fields: string[]): NonNullable<PreparedResource['conflicts']> {
  return ({ qc, env, id, values }) =>
    fields.flatMap((field): Conflict[] => {
      const value = values[field]
      if (typeof value !== 'string' && typeof value !== 'number') return []
      let q = (qc.db as unknown as Kysely<Record<string, Record<string, unknown>>>)
        .selectFrom(key)
        .select(`${key}.id`)
        .where(`${key}.organization_id`, '=', env.organizationId)
        .where(`${key}.${field}`, '=', value)
        .where(`${key}.deleted_at`, 'is', null)
      if (id) q = q.where(`${key}.id`, '!=', id)
      return [
        {
          read: readMaybe(q.limit(1)),
          refuse: (row) => {
            if (row)
              throw new ApiError(
                409,
                'value_exists',
                `a ${key} record with ${field} ${JSON.stringify(value)} already exists (${String(row.id)})`,
              )
          },
        },
      ]
    })
}
