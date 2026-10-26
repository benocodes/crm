import {
  CommitOutcomeUnknown,
  CommittedResultInvalid,
  DEFAULT_MAX_SET_SIZE,
  ForeignOrganizationError,
  StatementFailed,
  StorageError,
  UNIT_ASSERTION_CONSTRAINT,
  UnitDriftError,
  planUnit,
  queryContext,
  toCompiled,
  type ConstraintKind,
  type D1Binding,
  type ExecutionResult,
  type PreparedOperation,
  type Row,
  type Runtime,
  type StorageIdentity,
} from '@vault/storage'
import type { D1Like, D1PreparedLike, D1ResultLike } from './binding.js'

export type { D1Like, D1PreparedLike, D1ResultLike } from './binding.js'

// The D1 runtime ([[CORE35]] C3), open source. Each mutation unit is EXACTLY ONE awaited `batch()`
// (statements, guards, events and the result select): no sequential-autocommit emulation. The plan phase
// precedes the batch; guards in the statements turn any drift into a no-op that the decoder reports. D1 cannot
// roll back after commit, so a decode failure is classified `committed_result_invalid` and a lost transport
// `commit_outcome_unknown`; neither is replayed or shown as success.

/** D1 binds at most 100 parameters per statement: the reason sets travel as ONE parameter (D19). */
export const D1_MAX_PARAMETERS = 100

const CONSTRAINT: Array<[RegExp, ConstraintKind]> = [
  [/FOREIGN KEY constraint failed/i, 'foreign_key'],
  [/UNIQUE constraint failed/i, 'unique'],
  [/CHECK constraint failed/i, 'check'],
  [/NOT NULL constraint failed/i, 'not_null'],
]

/**
 * Tells a statement failure (D1 rejected the batch and rolled it back) from a lost transport (the commit may or
 * may not have happened). A SQLite error token means the database answered; anything else is unknown.
 */
export function classifyD1Error(err: unknown): { drift: true } | { statement: true; kind: ConstraintKind } | { statement: false } {
  const message = `${(err as Error | null)?.message ?? ''} ${((err as Error | null)?.cause as Error | undefined)?.message ?? ''}`
  // A failed commit-time assertion (CORE36 D4) is drift, tested before the generic CHECK pattern: the batch rolled back.
  if (message.includes(`CHECK constraint failed: ${UNIT_ASSERTION_CONSTRAINT}`)) return { drift: true }
  for (const [pattern, kind] of CONSTRAINT) if (pattern.test(message)) return { statement: true, kind }
  if (/SQLITE_[A-Z_]+|no such (table|column)|syntax error/i.test(message)) return { statement: true, kind: 'other' }
  return { statement: false }
}

const encode = (value: unknown): unknown => {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Array.isArray(value)) return JSON.stringify(value) // D1's only array form: JSON text (CORE40 P6)
  return value
}

export interface D1RuntimeOptions {
  /** The one organisation this database serves (D18). */
  organizationId: string
  /** The cap on any bounded set (D7). See RESULT.md for the verified D1 limits behind the default. Default 100. */
  maxSetSize?: number
}

export function createD1Runtime(d1: D1Like, options: D1RuntimeOptions): Runtime {
  const maxSetSize = options.maxSetSize ?? DEFAULT_MAX_SET_SIZE
  const prepare = (sql: string, parameters: readonly unknown[]): D1PreparedLike => {
    if (parameters.length > D1_MAX_PARAMETERS) throw new StorageError(`a statement binds ${parameters.length} parameters; D1 allows ${D1_MAX_PARAMETERS}`)
    return d1.prepare(sql).bind(...parameters.map(encode))
  }
  return {
    dialect: 'd1',
    maxSetSize,
    async execute<T>(identity: StorageIdentity, prepared: PreparedOperation<T>): Promise<ExecutionResult<T>> {
      // Admission before any SQL: a D1 serves one organisation, and the context cannot reach another database.
      if (identity.organizationId !== options.organizationId) throw new ForeignOrganizationError()
      const qc = queryContext('d1', maxSetSize)
      const meta: unknown[] = []
      const planned = await planUnit(prepared, qc, async (reads) => {
        // One batch so several reads describe one snapshot.
        const results = await d1.batch(reads.map((r) => prepare(r.sql, r.parameters)))
        meta.push(...results.map((r) => r.meta))
        return Object.fromEntries(reads.map((r, i) => [r.key, (results[i]!.results ?? []) as Row[]]))
      })
      const steps = planned.unit.steps
      let results: D1ResultLike[] = []
      if (steps.length > 0) {
        // Build every statement BEFORE anything is sent: a statement that cannot be bound (too many parameters)
        // is a refusal of a never-sent unit, never a commit of unknown outcome.
        const statements = steps.map((s) => {
          const c = toCompiled(s.query)
          return prepare(c.sql, c.parameters)
        })
        try {
          results = await d1.batch(statements)
        } catch (err) {
          const c = classifyD1Error(err)
          if ('drift' in c) throw new UnitDriftError(prepared.name)
          if (c.statement) throw new StatementFailed(prepared.name, c.kind, err)
          throw new CommitOutcomeUnknown(prepared.name, err)
        }
        meta.push(...results.map((r) => r.meta))
      }
      const resultAt = steps.findIndex((s) => s.label === 'result')
      let value: T
      try {
        value = planned.unit.decode(resultAt >= 0 ? ((results[resultAt]?.results ?? []) as Row[]) : [], planned.found)
      } catch (err) {
        // A drifted unit was a no-op: nothing changed, so it is a refusal, not a committed-but-invalid result.
        if (err instanceof UnitDriftError || steps.length === 0) throw err
        throw new CommittedResultInvalid(prepared.name, err)
      }
      return {
        value,
        events: planned.unit.events,
        stats: {
          reads: planned.reads,
          writes: steps.length,
          locks: 0,
          statements: planned.reads + steps.length,
          roundTrips: (planned.reads > 0 ? 1 : 0) + (steps.length > 0 ? 1 : 0),
          meta,
        },
      }
    },
  }
}

export function d1Binding(d1: D1Like, options: D1RuntimeOptions): D1Binding {
  return { kind: 'd1', runtime: createD1Runtime(d1, options), organizationId: options.organizationId }
}
