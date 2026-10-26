import type { Expression, SqlBool } from 'kysely'
import type { QueryContext, Step } from './types.js'

export const UNIT_ASSERTION_CONSTRAINT = 'unit_assertion_holds'

export function assertStep(_qc: QueryContext, _condition: Expression<SqlBool>): Step {
  throw new Error('not implemented')
}

export function exactly(_qc: QueryContext, _s: Step, _n: number): Step[] {
  throw new Error('not implemented')
}
