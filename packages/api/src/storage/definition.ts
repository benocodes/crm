import type { Expression, ExpressionBuilder, SelectType, SqlBool } from 'kysely'
import type { z } from 'zod'
import { COLUMN_KINDS } from '@vault/storage'
import type { ColumnOf, PreparedOperation, PublicColumn, PhysicalTable, QueryContext, RowOf, Step, StorageDatabase, SyncHook, Table, ValueOf } from '@vault/storage'
import type { Actor } from '../context.js'
import type { CrudAction, Filter } from '../resources/define.js'
import type { ScopeSet } from '../scopes.js'

/**
 * The tables a definition may name at the type level. A table without a physical D1/Postgres counterpart in
 * COLUMN_KINDS is rejected when the definition is created (`definePreparedResource`).
 */
export type CrudTable = Table

/** What a prepared operation is built with: the trusted identity and the unit's injected clock and id source. */
export interface PreparedEnv {
  readonly actor: Actor
  readonly organizationId: string
  readonly scopes: ScopeSet
  readonly now: Date
  newId(): string
}

export type WriteMeta = { readonly op: 'create' | 'update'; readonly now: Date }
export type Values = Record<string, unknown>

/** A computed column's value: a literal of the column's type or an expression producing it. */
type ComputedValue<T extends Table, C extends ColumnOf<T>> = ValueOf<T, C> | Expression<ValueOf<T, C> | SelectType<StorageDatabase[T][C & keyof StorageDatabase[T]]>>
type Computed<T extends Table> = { [C in ColumnOf<T>]?: ComputedValue<T, C> }
type Stored<T extends Table> = { [C in ColumnOf<T>]?: ValueOf<T, C> }

/**
 * A record shape is valid for table `T` when every key is a PUBLIC column of `T` (secret columns are excluded)
 * and each field's output type fits the stored column. Anything else maps to `never`, so the call site fails.
 */
export type RecordShape<T extends Table, S> = {
  [K in keyof S]: K extends PublicColumn<T> ? (S[K] extends z.ZodType<infer O> ? ([O] extends [RowOf<T>[K]] ? S[K] : never) : never) : never
}

/**
 * A resource served by the generic prepared CRUD core ([[CORE35]] D3), generic over its concrete table.
 * Extension points are synchronous and DB-free: they return values or Kysely fragments and never run a query.
 */
export interface PreparedResource<T extends CrudTable = CrudTable, R extends { id: string } = { id: string }> {
  readonly executor: 'prepared'
  readonly name: string
  readonly eventName: string
  readonly table: T
  /** The public record. Its keys are the projection; none may be a secret column. */
  readonly record: z.ZodType<R> & { shape: Record<string, unknown> }
  readonly create?: z.ZodObject
  readonly update?: z.ZodObject
  readonly operations?: readonly CrudAction[]
  readonly scopeResource?: string
  readonly agentWritable?: readonly string[]
  readonly filters?: { readonly [K in ColumnOf<T>]?: Filter }
  /** Columns that must reference a principal visible to the organisation (checked after existence). */
  readonly references?: { readonly [K in ColumnOf<T>]?: { readonly table: 'principals' } }
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
  /** Extension 4: whole-operation override. */
  readonly override?: Partial<Record<CrudAction, (env: PreparedEnv, input: unknown) => PreparedOperation<unknown>>>
}

type Output<S extends z.ZodRawShape> = z.output<z.ZodObject<S>> extends infer O extends { id: string } ? O : never

/** Validates a definition. The record's shape is checked against the table at the call site (`RecordShape`). */
export function definePreparedResource<T extends Table, S extends z.ZodRawShape & RecordShape<T, S> & { id: z.ZodType<string> }>(
  def: Omit<PreparedResource<T, Output<S>>, 'executor' | 'record'> & { readonly record: z.ZodObject<S> },
): PreparedResource<T, Output<S>> {
  // The ONE reviewed cast of the definition layer: zod's conditional output type cannot be related to `Output<S>`
  // inside the generic body. Call sites are checked by `RecordShape` and proven by definition.typecheck.ts.
  const full = { executor: 'prepared' as const, ...def } as unknown as PreparedResource<T, Output<S>>
  const NAME = /^[a-z][a-z0-9_]*$/
  if (!NAME.test(full.name)) throw new Error(`invalid resource name "${full.name}"`)
  if (!(full.table in COLUMN_KINDS)) throw new Error(`table "${full.table}" has no physical schema yet (${full.name})`)
  if (full.agentWritable) {
    const known = new Set([...Object.keys(full.create?.shape ?? {}), ...Object.keys(full.update?.shape ?? {})])
    for (const f of full.agentWritable) if (!known.has(f)) throw new Error(`agentWritable names unknown field "${f}" (${full.name})`)
  }
  return full
}

/** The definition's table as a physical table: `definePreparedResource` rejected any other at creation. */
export const physicalTable = (def: { table: Table }): PhysicalTable => def.table as PhysicalTable

export const isPrepared = (def: unknown): def is PreparedResource<any, any> => (def as { executor?: unknown } | null)?.executor === 'prepared'
export type { PublicColumn }
