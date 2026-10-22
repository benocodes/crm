import type { Compilable, CompiledQuery, Kysely } from 'kysely'
import type { StorageDatabase } from './database.js'
import type { Found } from './program.js'

export type Dialect = 'postgres' | 'd1'
/**
 * `first-mutation`, `first-event` and `result` are the fault-injection points of a unit; `fault` marks a
 * statement spliced in by a test. A unit has at most one `result`.
 */
export type StatementLabel = 'first-mutation' | 'first-event' | 'result' | 'fault'
export type Row = Readonly<Record<string, unknown>>
export type QueryLike = Compilable<unknown> | CompiledQuery<unknown>

/** What a program builds queries with: a COLD Kysely for the runtime's dialect, and the runtime's cap. */
export interface QueryContext {
  readonly db: Kysely<StorageDatabase>
  readonly dialect: Dialect
  readonly maxSetSize: number
}

/**
 * `one`: exactly one row (a missing row is a program error). `maybe`: zero or one. `all`: any number
 * (a list page). `set`: a bounded set (D7): the runtime reads at most `maxSetSize + 1` rows and refuses above the cap.
 */
export type ReadMode = 'one' | 'maybe' | 'all' | 'set'
export interface Read {
  readonly query: QueryLike
  readonly mode: ReadMode
}

export interface Step {
  readonly label?: StatementLabel
  readonly query: QueryLike
  /** Postgres aborts the unit when the statement affects no row; on D1 the unit's later statements are gated in SQL instead. */
  readonly expect?: 'affected'
}
export interface EventReceipt {
  readonly id: string
  readonly type: string
  readonly resourceType: string
  readonly resourceId: string
}
export interface Unit<T> {
  readonly steps: readonly Step[]
  readonly events: readonly EventReceipt[]
  /** Pure. Receives the rows of the `result` step (empty when there is none) and the planned reads. */
  readonly decode: (rows: readonly Row[], found: Found) => T
}

/**
 * A bounded program run as one atomic unit ([[CORE35]] C1): `reads` (the plan phase) are typed queries the
 * runtime runs first; `build` is pure and synchronous (no async business hook) and turns what was found
 * into the ordered, labelled statements, the events and the result decoder.
 */
export interface PreparedOperation<T> {
  readonly name: string
  /** false: a read-only unit (no statements; Postgres skips the organisation writer lock). */
  readonly mutates: boolean
  readonly reads: (qc: QueryContext) => Readonly<Record<string, Read>>
  readonly build: (found: Found, qc: QueryContext) => Unit<T>
}

/** Trusted tenant identity ([[CORE35]] C1). Account and internal variants arrive in CORE37. */
export interface StorageIdentity {
  readonly actorId: string
  readonly organizationId: string
}

export interface ExecutionStats {
  /** Plan-phase reads executed. */
  readonly reads: number
  /** Statements of the unit executed (all, including events and the result select). */
  readonly writes: number
  /** Lock statements (Postgres organisation writer lock). */
  readonly locks: number
  /** Everything sent to the database (reads + writes + locks). */
  readonly statements: number
  /** Batches or transactions used to run the unit's statements (D1: 1 for a mutation; Postgres: 1 transaction). */
  readonly roundTrips: number
}
export interface ExecutionResult<T> {
  readonly value: T
  /** The events the committed unit wrote. Present only after the whole unit committed. */
  readonly events: readonly EventReceipt[]
  readonly stats: ExecutionStats
}

export interface Runtime {
  readonly dialect: Dialect
  readonly maxSetSize: number
  execute<T>(identity: StorageIdentity, prepared: PreparedOperation<T>): Promise<ExecutionResult<T>>
}
/** Selected by trusted composition code before authentication; never by request input. */
export interface PostgresBinding {
  readonly kind: 'postgres'
  readonly runtime: Runtime
}
export interface D1Binding {
  readonly kind: 'd1'
  readonly runtime: Runtime
  /** The one organisation this D1 database serves. */
  readonly organizationId: string
}
export type StorageBinding = PostgresBinding | D1Binding

/** Runs a mutation or read unit on the binding. No replay of unknown outcomes. */
export function execute<T>(binding: StorageBinding, identity: StorageIdentity, prepared: PreparedOperation<T>): Promise<ExecutionResult<T>> {
  return binding.runtime.execute(identity, prepared)
}
