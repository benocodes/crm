import { sql, type Expression, type SqlBool } from 'kysely'
import type { QueryContext, Step } from './types.js'

/** The CHECK of the always-empty `unit_assertion` table; the D1 runtime classifies its failure as drift. */
export const UNIT_ASSERTION_CONSTRAINT = 'unit_assertion_holds'

/**
 * A commit-time assertion inside a unit ([[CORE36]] D4). When `condition` is false the whole unit aborts as drift.
 * D1: `INSERT INTO unit_assertion (ok) SELECT 0 WHERE NOT (<condition>)` inserts nothing while the condition holds
 * and fails the named CHECK (aborting the batch) when it does not. Postgres: `SELECT (<condition>) AS holds`, which
 * the runtime requires to be true. NOTE for D1: a statement that inserts no row resets `changes()` to 0, so a
 * statement gated on `appliedPrev` must not directly follow an assertion.
 */
export function assertStep(qc: QueryContext, condition: Expression<SqlBool>): Step {
  // Labelled escape hatches (dialect-specific SQL; see RESULT.md inventory).
  if (qc.dialect === 'd1') return { query: sql`insert into "unit_assertion" ("ok") select 0 where not (${condition})`.compile(qc.db) }
  return { query: sql`select (${condition}) as "holds"`.compile(qc.db), expect: 'holds' }
}

/**
 * The step affected exactly `n` rows, or the unit aborts as drift. Postgres: the runtime checks `{ rows: n }`.
 * D1: the step followed by an assertion on `changes() = n` (it must be the statement immediately before it).
 */
export function exactly(qc: QueryContext, s: Step, n: number): Step[] {
  if (qc.dialect === 'postgres') return [{ ...s, expect: { rows: n } }]
  return [s, assertStep(qc, sql<SqlBool>`changes() = ${n}`)]
}
