import type { Expression, ExpressionBuilder, SelectType, SqlBool } from 'kysely'
import type { z } from 'zod'
import { COLUMN_KINDS, checkEmbed, type EmbedSpec } from '@vault/storage'
import type { ColumnOf, PreparedOperation, PublicColumn, PhysicalTable, QueryContext, Read, RowOf, Step, StorageDatabase, SyncHook, Table, ValueOf, Row } from '@vault/storage'
import type { Actor } from '../auth/types.js'
import type { Surface } from '../surfaces.js'
import type { CrudAction, Filter } from '../resources/define.js'
import type { Scope, ScopeSet } from '../scopes.js'
import type { SortKind } from '../resources/sort-cursor.js'
import type { ObjectStore } from '../objects/store.js'

/**
 * The tables a definition may name at the type level. A table without a physical D1/Postgres counterpart in
 * COLUMN_KINDS is rejected when the definition is created (`definePreparedResource`).
 */
export type CrudTable = Table

/** What a prepared operation is built with: the trusted identity and the unit's injected clock and id source. */
export interface PreparedEnv {
  /** Send-specific immutable authored bytes are stored before the authorisation unit (AGT166 D64). */
  readonly objects?: ObjectStore
  readonly actor: Actor
  readonly organizationId: string
  readonly scopes: ScopeSet
  readonly now: Date
  newId(): string
  /** The injected random source (CORE40 P8), beside the clock and ids, so golden runs can record a key. */
  randomBytes(n: number): Uint8Array
}

export type WriteMeta = { readonly op: 'create' | 'update'; readonly now: Date }

/**
 * A reference column's target ([[CORE36]] D4): a portable table, and `live` to require `deleted_at IS NULL`. The plan
 * read (`400 invalid_reference`) and the commit-time guard use ONE predicate: `id = v`, plus `organization_id = the
 * unit's organisation` when the target table has that column, plus `deleted_at IS NULL` when `live`.
 */
export type ReferenceTarget = { readonly table: 'principals' | 'companies' | 'contacts' | 'files' | 'pipelines' | 'pipeline_stages'; readonly live?: boolean }

/** A refusal decided from a plan read (a domain or an address already taken): the core runs `read`, then `refuse(row | null)`. */
export interface Conflict {
  readonly read: Read
  readonly refuse: (found: Row | null) => void
}
export type Values = Record<string, unknown>

/** A computed column's value: a literal of the column's type or an expression producing it. */
type ComputedValue<T extends Table, C extends ColumnOf<T>> = ValueOf<T, C> | Expression<ValueOf<T, C> | SelectType<StorageDatabase[T][C & keyof StorageDatabase[T]]>>
type Computed<T extends Table> = { [C in ColumnOf<T>]?: ComputedValue<T, C> }
type Stored<T extends Table> = { [C in ColumnOf<T>]?: ValueOf<T, C> }

/**
 * An embedded child set of a record ([[CORE25]] D50): the child table, the column pointing at the parent, the columns
 * rendered into each element and their order. All are checked against the child table at the call site.
 */
export type EmbedDecl<Child extends Table = Table> = {
  readonly table: Child
  readonly key: ColumnOf<Child>
  readonly columns: readonly ColumnOf<Child>[]
  readonly orderBy: readonly ColumnOf<Child>[]
}
/** Embed field name -> child table, as inferred from the `embed` declaration. */
export type EmbedMap = Readonly<Record<string, Table>>
/** The embed fields, or none when E could not be inferred (a failed declaration falls back to the wide constraint, which must not read as "every key is an embed"). */
export type EmbedKeys<E> = string extends keyof E ? never : keyof E
export type EmbedInput<E extends EmbedMap> = { readonly [F in keyof E]: EmbedDecl<E[F]> }

/**
 * A derived field of a record ([[CORE131]] D1): read-only, computed from other tables when the record is read, never stored and
 * never in an event. `kind` is a column kind its value decodes as; `expression` returns a scalar fragment correlated on the parent row
 * (`parent('id')` is a reference to the parent table's column), already in the stored form of the kind (timestamps as ISO text).
 * Synchronous and DB-free like an embed. The field is rendered only for callers holding every scope in `requires`; `filters`
 * names the definition's custom filters that filter on it (schema discovery lists them).
 */
export type DerivedKind = 'timestamp' | 'text' | 'integer' | 'boolean'
export type DerivedDecl<K extends DerivedKind = DerivedKind> = {
  readonly kind: K
  readonly expression: (qc: QueryContext, parent: (column: string) => Expression<unknown>) => Expression<unknown>
  readonly requires?: readonly Scope[]
  readonly filters?: readonly string[]
}
/** What a derived field of each kind decodes to. */
type DerivedValue = { timestamp: string; text: string; integer: number; boolean: boolean }
/** Derived field name -> kind, as inferred from the `derived` declaration. */
export type DerivedMap = Readonly<Record<string, DerivedKind>>
/** The derived fields, or none when D could not be inferred. */
export type DerivedKeys<D> = string extends keyof D ? never : keyof D
export type DerivedInput<D extends DerivedMap> = { readonly [F in keyof D]: DerivedDecl<D[F]> }

/**
 * A record shape is valid for table `T` when every key is a PUBLIC column of `T` (secret columns are excluded)
 * and each field's output type fits the stored column, or an embed field of the definition whose schema is an array.
 * Anything else maps to `never`, so the call site fails.
 */
export type RecordShape<T extends Table, S, E extends EmbedMap = {}, D extends DerivedMap = {}> = {
  [K in keyof S]: K extends DerivedKeys<D>
    ? S[K] extends z.ZodType<infer O>
      ? [O] extends [DerivedValue[D[K & keyof D]] | null | undefined]
        ? S[K]
        : never
      : never
    : K extends EmbedKeys<E>
    ? S[K] extends z.ZodType<infer O>
      ? [O] extends [readonly unknown[]]
        ? S[K]
        : never
      : never
    : K extends PublicColumn<T>
      ? S[K] extends z.ZodType<infer O>
        ? [O] extends [RowOf<T>[K]]
          ? S[K]
          : never
        : never
      : never
}

/**
 * A list filter that is not a column of the table ([[CORE25]] D51): an engine-neutral predicate, e.g. an `EXISTS` over a
 * child table. Synchronous and DB-free like every extension: it returns a Kysely fragment and never runs a query.
 */
export type CustomFilter = Filter & {
  readonly where: (qc: QueryContext, value: unknown) => Expression<SqlBool>
  /** Scopes the caller needs on top of the list's own to use this filter ([[CORE129]] D12): checked before the query, `403 insufficient_scope` naming the first missing one. */
  readonly requires?: readonly Scope[]
}

/**
 * A resource served by the generic prepared CRUD core ([[CORE35]] D3), generic over its concrete table.
 * Extension points are synchronous and DB-free: they return values or Kysely fragments and never run a query.
 */
export interface PreparedResource<T extends CrudTable = CrudTable, R extends { id: string } = { id: string }> {
  /** [[API32]] D1: which surface serves the definition's operations; required, no default. */
  readonly surface: Surface
  readonly name: string
  readonly eventName: string
  readonly table: T
  /** The public record. Its keys are the projection; none may be a secret column. */
  readonly record: z.ZodType<R> & { shape: Record<string, unknown> }
  readonly create?: z.ZodObject
  readonly update?: z.ZodObject
  readonly operations?: readonly CrudAction[]
  readonly scopeResource?: string
  /** [[CHN5]] D29: the table exists on D1 only, so every generated operation answers `501 not_implemented` on another engine (checked before any unit runs). */
  readonly d1Only?: boolean
  /**
   * [[AGT8]] D32: set (with the reason a client is told) when the definition's generated writes may not be the target of an action
   * request. Absent: its create, update and delete are proposable (the manifest test pins the resulting list).
   */
  readonly notProposable?: string
  /**
   * [[CORE62]] D9: the table may be an endpoint of an association. The associable set, and each type's read scope
   * (`scopeResource`), come from the registry's definitions; table names reach SQL from here, never from input.
   */
  readonly associable?: boolean
  /**
   * [[CORE129]] D8: the table types this one may be linked to. Absent: any associable type. `associations.create` refuses a pair when
   * either end declares a list that does not contain the other (`400 validation_error`); the names are checked against the associable set at registry load.
   */
  readonly neighbours?: readonly string[]
  readonly agentWritable?: readonly string[]
  readonly filters?: { readonly [K in ColumnOf<T>]?: Filter }
  /** List filters that are not columns (their keys never are, and never also in `filters`): `where` is ANDed into the list query. */
  readonly customFilters?: Readonly<Record<string, CustomFilter>>
  /** Embedded child rows rendered into the record and into an event's `after` (the record names the field as an array). */
  readonly embed?: Readonly<Record<string, EmbedSpec>>
  /**
   * [[CORE131]] D1: record fields computed from other tables (read-only, not columns, never in events). The record schema must name
   * each as an optional field: it is absent for a caller without the field's `requires` scopes.
   */
  readonly derived?: Readonly<Record<string, DerivedDecl>>
  /**
   * [[CORE133]] D8: the derived fields a list can be sorted by (names from `derived`; stored columns come later). A list that declares them takes
   * `sort` and `order`, pages sorted results with an opaque cursor bound to that sort, and types `after`/`next_cursor` as strings.
   * `null` sorts as the oldest value and ties break on `id` in the same direction.
   */
  readonly sorts?: readonly string[]
  /**
   * [[CORE188]] D2: text appended to the list's `sort` parameter description, for a list whose sorted fields need a meaning spelled out
   * (action_executions). Absent on every other list, so their text is unchanged.
   */
  readonly sortNote?: string
  /** CORE170: resolved column/derived kinds, supplied only by the explicit withColumnSorts capability. */
  readonly sortKinds?: Readonly<Record<string, SortKind>>
  /** Columns that must reference a visible row of a portable table (checked after existence, re-checked at commit). */
  readonly references?: { readonly [K in ColumnOf<T>]?: ReferenceTarget }
  /**
   * [[CORE130]] D3, D9: fields accepted on create and refused on update (`400 validation_error`), each with the sentence that says where
   * to change it instead (empty: none). Checked before the update schema, so the answer names the field, not "unrecognized key".
   */
  readonly createOnly?: Readonly<Record<string, string>>
  /**
   * [[CORE130]] D9, D11: columns a create stores that come from other rows, read in the same statement as the insert (the deal's pipeline,
   * the stage's kind): typed expressions per column, evaluated at commit with the reference guards, so no plan read can go stale.
   * Synchronous and DB-free; the values are `stored` (prepared) input.
   */
  readonly createComputed?: (c: { eb: ExpressionBuilder<StorageDatabase, T>; qc: QueryContext; env: PreparedEnv; values: Values }) => Computed<T>
  /** Extension 1: pure normalization of a validated write; returns the column values to store. */
  readonly prepare?: SyncHook<{ values: Values; meta: WriteMeta }, Stored<T>>
  /**
   * Extension 2 (with `computed`): typed values or expressions for columns derived from the STORED row at commit
   * time (the task completion CASE). Keys are columns of the table, values are checked against the column type.
   */
  readonly computed?: (c: { eb: ExpressionBuilder<StorageDatabase, T>; qc: QueryContext; values: Values; now: Date }) => Computed<T>
  /** Extension 2: extra typed predicates ANDed into update and delete. */
  readonly guards?: (eb: ExpressionBuilder<StorageDatabase, T>, env: PreparedEnv) => Expression<SqlBool>[]
  /** Extension 3: extra statements after the main write (cascades, tombstones). Synchronous. */
  readonly after?: (c: { qc: QueryContext; env: PreparedEnv; op: CrudAction; id: string }) => Step[]
  /**
   * Extension 4: whole-operation override. `resourceOperations` uses it instead of the generic operation; the
   * input is `{ after, limit, filters }` for list, the id for get and delete, the body for create and `{ id, body }` for update.
   */
  readonly override?: Partial<Record<CrudAction, (env: PreparedEnv, input: unknown) => PreparedOperation<unknown>>>
  /**
   * Extension 5: refusals decided from extra plan reads, after the reference checks (a company domain or an identity
   * address already taken). Synchronous and DB-free: it returns typed queries. `values` are the prepared (normalised) values.
   */
  readonly conflicts?: (c: { qc: QueryContext; env: PreparedEnv; op: 'create' | 'update'; id: string | null; values: Values }) => readonly Conflict[]
}

type Output<S extends z.ZodRawShape> = z.output<z.ZodObject<S>> extends infer O extends { id: string } ? O : never

/** Validates a definition. The record's shape is checked against the table at the call site (`RecordShape`). */
export function definePreparedResource<T extends Table, S extends z.ZodRawShape & RecordShape<T, S, E, D> & { id: z.ZodType<string> }, E extends EmbedMap = {}, D extends DerivedMap = {}>(
  def: Omit<PreparedResource<T, Output<S>>, 'record' | 'embed' | 'derived'> & { readonly record: z.ZodObject<S>; readonly embed?: EmbedInput<E>; readonly derived?: DerivedInput<D> },
): PreparedResource<T, Output<S>> {
  // The ONE reviewed cast of the definition layer: zod's conditional output type cannot be related to `Output<S>`
  // inside the generic body. Call sites are checked by `RecordShape` and proven by definition.typecheck.ts.
  const full = { ...def } as unknown as PreparedResource<T, Output<S>>
  const NAME = /^[a-z][a-z0-9_]*$/
  if (!NAME.test(full.name)) throw new Error(`invalid resource name "${full.name}"`)
  if (!(full.table in COLUMN_KINDS)) throw new Error(`table "${full.table}" has no physical schema yet (${full.name})`)
  // A table without `deleted_at` is hard-lived (agents, api_keys): it has no delete, and the generic core adds no live-row condition (CORE40 P4).
  if (!softDeletes(full)) {
    if (full.operations?.includes('delete')) throw new Error(`${full.name}: delete needs a deleted_at column on "${full.table}"`)
    if (!full.operations) (full as { operations?: readonly CrudAction[] }).operations = ['list', 'get', 'create', 'update']
  }
  for (const [column, ref] of Object.entries(full.references ?? {}) as Array<[string, ReferenceTarget | undefined]>) {
    if (!ref) continue
    const kinds = (COLUMN_KINDS as Record<string, Record<string, unknown>>)[ref.table]
    if (!kinds) throw new Error(`reference ${column} names table "${ref.table}" with no physical schema (${full.name})`)
    if (ref.live && !('deleted_at' in kinds)) throw new Error(`reference ${column} is live but "${ref.table}" has no deleted_at (${full.name})`)
  }
  const kindsOfTable = (COLUMN_KINDS as Record<string, Record<string, unknown>>)[full.table]!
  for (const key of Object.keys(full.customFilters ?? {})) {
    if (key in kindsOfTable) throw new Error(`customFilters key "${key}" is a column of ${full.table}: declare it in filters (${full.name})`)
    if (key in (full.filters ?? {})) throw new Error(`customFilters key "${key}" is also in filters (${full.name})`)
  }
  for (const [field, spec] of Object.entries(full.embed ?? {})) {
    try {
      checkEmbed(spec)
    } catch (err) {
      throw new Error(`embed "${field}" (${full.name}): ${(err as Error).message}`)
    }
    if (field in kindsOfTable) throw new Error(`embed "${field}" is also a column of ${full.table} (${full.name})`)
    if (!(field in full.record.shape)) throw new Error(`embed "${field}" is not a field of the record (${full.name})`)
  }
  for (const [field, spec] of Object.entries(full.derived ?? {})) {
    if (field in kindsOfTable) throw new Error(`derived "${field}" is a column of ${full.table} (${full.name})`)
    if (field in (full.embed ?? {})) throw new Error(`derived "${field}" is also an embed (${full.name})`)
    // [[CORE130]] D8: the derived field may be filtered by a custom filter of its own name (`?status=`) - that is what `filters` declares - but a column filter may not take it.
    if (field in (full.filters ?? {}) || (field in (full.customFilters ?? {}) && !(spec.filters ?? []).includes(field))) throw new Error(`derived "${field}" is also a filter key (${full.name})`)
    if (!(field in full.record.shape)) throw new Error(`derived "${field}" is not a field of the record (${full.name})`)
    for (const f of spec.filters ?? []) if (!(f in (full.customFilters ?? {}))) throw new Error(`derived "${field}" names filter "${f}", which is not a custom filter (${full.name})`)
  }
  const sorts = full.sorts ?? []
  sorts.forEach((field, i) => {
    const d = (full.derived ?? {})[field]
    if (!d) throw new Error(`sorts "${field}" is not a derived field of ${full.name}`)
    if (d.kind === 'boolean') throw new Error(`sorts "${field}" is a boolean derived field, which has no order (${full.name})`)
    if (sorts.indexOf(field) !== i) throw new Error(`sorts "${field}" is listed twice (${full.name})`)
  })
  if (sorts.length > 0) {
    for (const key of ['sort', 'order']) {
      if (key in (full.filters ?? {}) || key in (full.customFilters ?? {})) throw new Error(`"${key}" is a parameter of a sorted list and cannot also be a filter (${full.name})`)
    }
  }
  if (full.associable) {
    const kinds = (COLUMN_KINDS as Record<string, Record<string, unknown>>)[full.table]!
    if (!('id' in kinds)) throw new Error(`${full.name}: an associable table needs an id column`)
    if (!/^[a-z][a-z0-9_]*$/.test(full.table)) throw new Error(`${full.name}: an associable table name must be a lowercase identifier`)
  }
  if (full.agentWritable) {
    const known = new Set([...Object.keys(full.create?.shape ?? {}), ...Object.keys(full.update?.shape ?? {})])
    for (const f of full.agentWritable) if (!known.has(f)) throw new Error(`agentWritable names unknown field "${f}" (${full.name})`)
  }
  return full
}

/** Whether rows of the definition's table are soft-deleted: it has a `deleted_at` column (CORE40 P4). */
export const softDeletes = (def: { table: Table }): boolean => 'deleted_at' in (COLUMN_KINDS as Record<string, Record<string, unknown>>)[def.table]!

/** The definition's table as a physical table: `definePreparedResource` rejected any other at creation. */
export const physicalTable = (def: { table: Table }): PhysicalTable => def.table as PhysicalTable

export type { PublicColumn }
