import type { Found, PreparedOperation, QueryContext, Read, Unit } from '@vault/storage'
import { defineOperation } from '@vault/storage'

/**
 * The exported plan/build pair of a concrete identity program ([[CORE36]] D15): `reads` is the plan phase, `build`
 * turns what it found into the ordered unit. There is no composition API; CORE25's capture unit composes these later.
 * Read keys are namespaced (`resolve:`, `own:`, `merge:`) so two programs can share one unit.
 */
export interface Program<T> {
  reads(qc: QueryContext): Readonly<Record<string, Read>>
  build(found: Found, qc: QueryContext): Unit<T>
}

/** A mutating prepared operation that runs `program` as one atomic unit. */
export const operationOf = <T>(name: string, program: Program<T>): PreparedOperation<T> =>
  defineOperation<T>({ name, mutates: true, reads: (qc) => program.reads(qc), build: (found, qc) => program.build(found, qc) })
