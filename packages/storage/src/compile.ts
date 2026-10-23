import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect as KyselyDialect,
  type Driver,
  type QueryResult,
} from 'kysely'
import type { StorageDatabase } from './database.js'
import { ColdExecutionError } from './errors.js'
import { Found, type FoundInput, compileReads, toCompiled } from './program.js'
import type { Dialect, EventReceipt, PreparedOperation, QueryContext, ReadMode, StatementLabel } from './types.js'

/** A connection whose every execution throws: a cold database can only compile. */
class ColdConnection implements DatabaseConnection {
  async executeQuery<R>(): Promise<QueryResult<R>> {
    throw new ColdExecutionError()
  }
  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new ColdExecutionError()
  }
}

/**
 * A driver that can only compile. It hands out a throwing connection (rather than failing to acquire one,
 * which would leak SQLite's single-connection mutex), so an accidental run can never look like an empty result.
 */
class ColdDriver implements Driver {
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new ColdConnection()
  }
  async beginTransaction(): Promise<void> {
    throw new ColdExecutionError()
  }
  async commitTransaction(): Promise<void> {
    throw new ColdExecutionError()
  }
  async rollbackTransaction(): Promise<void> {
    throw new ColdExecutionError()
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

const cold: Partial<Record<Dialect, Kysely<StorageDatabase>>> = {}

/** A Kysely that compiles for `dialect` (Postgres `$n` placeholders; D1/SQLite `?`) and never executes. */
export function coldDb(dialect: Dialect): Kysely<StorageDatabase> {
  const cached = cold[dialect]
  if (cached) return cached
  const kyselyDialect: KyselyDialect =
    dialect === 'postgres'
      ? {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new ColdDriver(),
          createIntrospector: (db) => new PostgresIntrospector(db),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        }
      : {
          createAdapter: () => new SqliteAdapter(),
          createDriver: () => new ColdDriver(),
          createIntrospector: (db) => new SqliteIntrospector(db),
          createQueryCompiler: () => new SqliteQueryCompiler(),
        }
  return (cold[dialect] = new Kysely<StorageDatabase>({ dialect: kyselyDialect }))
}

/** The cap every runtime starts with (spec D7); a runtime sets its own. */
export const DEFAULT_MAX_SET_SIZE = 100

export function queryContext(dialect: Dialect, maxSetSize: number = DEFAULT_MAX_SET_SIZE): QueryContext {
  return { db: coldDb(dialect), dialect, maxSetSize }
}

export interface CompiledRead {
  readonly key: string
  readonly mode: ReadMode
  readonly sql: string
  readonly parameters: readonly unknown[]
  /** Set reads are limited to the cap plus one, so a larger set is detected, not truncated. */
  readonly limit?: number
}
export interface CompiledStatement {
  readonly label?: StatementLabel
  readonly sql: string
  readonly parameters: readonly unknown[]
  readonly expect?: 'affected'
}
export interface CompiledOperation {
  readonly name: string
  readonly mutates: boolean
  readonly reads: readonly CompiledRead[]
  readonly statements: readonly CompiledStatement[]
  readonly events: readonly EventReceipt[]
  readonly found: Found
}

/**
 * Compiles a prepared operation for `dialect` without a database: its reads, then (given what those reads
 * would have found) its statements in order. For tests and tooling; runtimes run the same compilation.
 */
export function compileOperation<T>(
  prepared: PreparedOperation<T>,
  dialect: Dialect,
  found: FoundInput = {},
  opts: { maxSetSize?: number } = {},
): CompiledOperation {
  const qc = queryContext(dialect, opts.maxSetSize)
  const reads = compileReads(prepared.reads(qc), qc)
  const foundRows = Found.from(found)
  const unit = prepared.build(foundRows, qc)
  return {
    name: prepared.name,
    mutates: prepared.mutates,
    reads,
    statements: unit.steps.map((s) => {
      const c = toCompiled(s.query)
      return { ...(s.label ? { label: s.label } : {}), sql: c.sql, parameters: c.parameters, ...(s.expect ? { expect: s.expect } : {}) }
    }),
    events: unit.events,
    found: foundRows,
  }
}

export { CompiledQuery }
