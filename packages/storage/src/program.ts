import { sql, type AliasedExpression, type CompiledQuery, type Expression, type RawBuilder, type SqlBool } from 'kysely'
import { COLUMN_KINDS, type ColumnKind, type PhysicalTable } from './database.js'
import { SetLimitExceeded, StorageError } from './errors.js'
import type { CompiledRead } from './compile.js'
import type {
  PreparedOperation,
  QueryContext,
  QueryLike,
  Read,
  ReadMode,
  Row,
  Step,
  StatementLabel,
  Unit,
} from './types.js'

export type { Row }

// ---- reads --------------------------------------------------------------------------------------------

export const readOne = (query: QueryLike): Read => ({ query, mode: 'one' })
export const readMaybe = (query: QueryLike): Read => ({ query, mode: 'maybe' })
export const readAll = (query: QueryLike): Read => ({ query, mode: 'all' })
/** A bounded set (D7): refused above the runtime's cap before anything is built or written. */
export const readSet = (query: QueryLike): Read => ({ query, mode: 'set' })

export const toCompiled = (query: QueryLike): CompiledQuery<unknown> => ('compile' in query ? query.compile() : query)

export type FoundInput = Readonly<Record<string, Row | readonly Row[] | null>>

/** What the plan phase found, by read key. */
export class Found {
  private constructor(private readonly rows: Readonly<Record<string, readonly Row[]>>) {}

  static from(input: FoundInput): Found {
    return new Found(
      Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, v === null ? [] : Array.isArray(v) ? (v as readonly Row[]) : [v as Row]]),
      ),
    )
  }
  static ofRows(rows: Readonly<Record<string, readonly Row[]>>): Found {
    return new Found(rows)
  }
  one(key: string): Row {
    const rows = this.rows[key] ?? []
    if (rows.length !== 1) throw new StorageError(`read "${key}" expected exactly one row, found ${rows.length}`)
    return rows[0]!
  }
  maybe(key: string): Row | null {
    const rows = this.rows[key] ?? []
    if (rows.length > 1) throw new StorageError(`read "${key}" expected at most one row, found ${rows.length}`)
    return rows[0] ?? null
  }
  all(key: string): readonly Row[] {
    return this.rows[key] ?? []
  }
}

export function compileReads(reads: Readonly<Record<string, Read>>, qc: QueryContext): CompiledRead[] {
  return Object.entries(reads).map(([key, read]) => {
    const c = toCompiled(read.query)
    if (read.mode !== 'set') return { key, mode: read.mode, sql: c.sql, parameters: c.parameters }
    const limit = qc.maxSetSize + 1
    const placeholder = qc.dialect === 'postgres' ? `$${c.parameters.length + 1}` : '?'
    return {
      key,
      mode: read.mode,
      sql: `select * from (${c.sql}) as "bounded" limit ${placeholder}`,
      parameters: [...c.parameters, limit],
      limit,
    }
  })
}

// ---- units --------------------------------------------------------------------------------------------

export function step(query: QueryLike, label?: StatementLabel, opts: { expect?: Step['expect'] } = {}): Step {
  return { ...(label ? { label } : {}), query, ...(opts.expect ? { expect: opts.expect } : {}) }
}

const RANK: Record<string, number> = { 'first-mutation': 0, 'first-event': 1, result: 2 }

/** Builds a unit and checks its shape: stage order mutation < event < result, at most one result. */
export function unit<T>(u: Unit<T>): Unit<T> {
  const results = u.steps.filter((s) => s.label === 'result')
  if (results.length > 1) throw new StorageError('a unit has at most one result step')
  let last = -1
  for (const s of u.steps) {
    const rank = s.label ? (RANK[s.label] ?? -1) : -1
    if (rank < 0) continue
    if (rank < last) throw new StorageError(`statement order: "${s.label}" may not follow a later stage (mutation, then event, then result)`)
    last = rank
  }
  const resultAt = u.steps.findIndex((s) => s.label === 'result')
  if (resultAt >= 0 && u.steps.slice(resultAt + 1).some((s) => s.label === 'first-mutation' || s.label === 'first-event')) {
    throw new StorageError('statement order: nothing but a fault may follow the result')
  }
  return u
}

/** Names a program. Validation of the unit happens in `unit()` when `build` runs. */
export function defineOperation<T>(spec: PreparedOperation<T>): PreparedOperation<T> {
  if (spec.name.trim() === '') throw new StorageError('an operation needs a name')
  return spec
}

/**
 * The plan phase, shared by every runtime: runs the reads through `runReads`, refuses an over-cap set before
 * `build` runs (so nothing is planned, built or written), then builds the unit.
 */
export async function planUnit<T>(
  prepared: PreparedOperation<T>,
  qc: QueryContext,
  runReads: (reads: readonly CompiledRead[]) => Promise<Readonly<Record<string, readonly Row[]>>>,
): Promise<{ unit: Unit<T>; found: Found; reads: number }> {
  const reads = compileReads(prepared.reads(qc), qc)
  const rows = reads.length > 0 ? await runReads(reads) : {}
  for (const read of reads) {
    const got = rows[read.key] ?? []
    if (read.mode === 'set' && got.length > qc.maxSetSize) throw new SetLimitExceeded(qc.maxSetSize, got.length)
  }
  const found = Found.ofRows(rows)
  return { unit: prepared.build(found, qc), found, reads: reads.length }
}

// ---- dialect fragments (the labelled `sql<T>` escape hatches; see RESULT.md inventory) ----------------

const refOf = (path: string) => sql.ref(path)

/** Binds `value` with the cast Postgres needs for an otherwise untyped parameter in INSERT...SELECT; D1 binds it plain. */
export function bind(qc: QueryContext, kind: ColumnKind, value: string | boolean | readonly string[] | null): RawBuilder<string> {
  // A string array is bound as ONE parameter; the D1 runtime encodes it as JSON text (the column's only array form).
  if (qc.dialect === 'd1') return sql<string>`${value}`
  const type = { uuid: 'uuid', text: 'text', timestamp: 'timestamptz', json: 'jsonb', boolean: 'boolean', string_array: 'text[]' }[kind]
  return sql<string>`cast(${value} as ${sql.raw(type)})`
}

const PG_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
const PG_EXACT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

export const ts = {
  /** The timestamp as ISO text with milliseconds (the public record form, identical on both engines). */
  iso: (qc: QueryContext, ref: string): RawBuilder<string> =>
    qc.dialect === 'postgres' ? sql<string>`to_char(${refOf(ref)} at time zone 'UTC', ${sql.lit(PG_ISO)})` : sql<string>`${refOf(ref)}`,
  /** The timestamp at full stored precision (microseconds on Postgres): for drift guards, never for records. */
  exact: (qc: QueryContext, ref: string): RawBuilder<string> =>
    qc.dialect === 'postgres' ? sql<string>`to_char(${refOf(ref)} at time zone 'UTC', ${sql.lit(PG_EXACT)})` : sql<string>`${refOf(ref)}`,
}

/** SQL for "the previous statement of this unit changed a row" (D1); Postgres checks affected rows in the runtime instead. */
export function appliedPrev(qc: QueryContext): Expression<SqlBool> {
  return qc.dialect === 'd1' ? sql<SqlBool>`changes() > 0` : sql<SqlBool>`true`
}

/**
 * The record of a stored row as JSON text/jsonb, built in SQL from the stored columns so that an event's
 * `after` is the stored row, not a recomputation (timestamps in the public ISO form).
 */
export function recordJson(qc: QueryContext, table: PhysicalTable, columns: readonly string[]): RawBuilder<string> {
  const kinds = COLUMN_KINDS[table] as Record<string, ColumnKind>
  const pairs = columns.map((c) => {
    const ref = `${table}.${c}`
    const value =
      kinds[c] === 'timestamp'
        ? ts.iso(qc, ref)
        : kinds[c] === 'boolean' && qc.dialect === 'd1'
          ? sql`json(iif(${refOf(ref)}, 'true', 'false'))` // D1 stores 0/1; an event's `after` carries a JSON boolean on both engines
          : kinds[c] === 'string_array' && qc.dialect === 'd1'
            ? sql`json(${refOf(ref)})` // D1 stores a JSON array as text; an event's `after` carries a JSON array on both engines
            : sql`${refOf(ref)}`
    return sql`${sql.lit(c)}, ${value}`
  })
  return qc.dialect === 'postgres'
    ? sql<string>`jsonb_build_object(${sql.join(pairs)})`
    : sql<string>`json_object(${sql.join(pairs)})`
}

/** Selects a record's columns with timestamps rendered as public ISO text (same on both engines); `prefix` aliases them for a joined record. */
export function recordColumns(qc: QueryContext, table: PhysicalTable, columns: readonly string[], prefix = ''): AliasedExpression<unknown, string>[] {
  const kinds = COLUMN_KINDS[table] as Record<string, ColumnKind>
  return columns.map((c) => {
    const ref = `${table}.${c}`
    return (kinds[c] === 'timestamp' ? ts.iso(qc, ref) : sql<unknown>`${refOf(ref)}`).as(`${prefix}${c}`)
  })
}

export type { ReadMode }
