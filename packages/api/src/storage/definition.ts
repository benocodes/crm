import type { Expression, ExpressionBuilder, SqlBool } from 'kysely'
import type { z } from 'zod'
import type { ColumnOf, PreparedOperation, PublicColumn, StorageDatabase, Step, QueryContext, SyncHook } from '@vault/storage'
import type { Actor } from '../context.js'
import type { CrudAction, Filter } from '../resources/define.js'
import type { ScopeSet } from '../scopes.js'

/** The tables the generic CRUD core serves. Each cycle that migrates a resource widens this union. */
export type CrudTable = 'tasks'

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
  /** Extension 1: pure normalization of a validated write; returns the values to store. */
  readonly prepare?: SyncHook<{ values: Values; meta: WriteMeta }, Values>
  /**
   * Extension 2 (with `computed`): typed expressions for columns derived from the STORED row at commit time
   * (the task completion CASE). Keys are columns of the table; values are literals or expressions.
   */
  readonly computed?: (c: { eb: ExpressionBuilder<StorageDatabase, T>; qc: QueryContext; values: Values; now: Date }) => Record<string, unknown>
  /** Extension 2: extra typed predicates ANDed into update and delete. */
  readonly guards?: (eb: ExpressionBuilder<StorageDatabase, T>, env: PreparedEnv) => Expression<SqlBool>[]
  /** Extension 3: extra statements after the main write (cascades, tombstones). Synchronous. */
  readonly after?: (c: { qc: QueryContext; env: PreparedEnv; op: CrudAction; id: string }) => Step[]
  /** Extension 4: whole-operation override. */
  readonly override?: Partial<Record<CrudAction, (env: PreparedEnv, input: unknown) => PreparedOperation<unknown>>>
}

export function definePreparedResource<T extends CrudTable, R extends { id: string }>(def: Omit<PreparedResource<T, R>, 'executor'>): PreparedResource<T, R> {
  const full = { executor: 'prepared' as const, ...def }
  const NAME = /^[a-z][a-z0-9_]*$/
  if (!NAME.test(full.name)) throw new Error(`invalid resource name "${full.name}"`)
  const secret = new Set<string>(['key_hash'])
  for (const column of Object.keys(full.record.shape)) {
    if (secret.has(column)) throw new Error(`secret column "${column}" in the public record of ${full.name}`)
  }
  if (full.agentWritable) {
    const known = new Set([...Object.keys(full.create?.shape ?? {}), ...Object.keys(full.update?.shape ?? {})])
    for (const f of full.agentWritable) if (!known.has(f)) throw new Error(`agentWritable names unknown field "${f}" (${full.name})`)
  }
  return full
}

export const isPrepared = (def: unknown): def is PreparedResource<any, any> => (def as { executor?: unknown } | null)?.executor === 'prepared'
export type { PublicColumn }
