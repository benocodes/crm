// Test helpers shared by the runtimes' suites (engine-neutral): fault injection.
import { sql } from 'kysely'
import { step, unit } from '../program.js'
import type { PreparedOperation, StatementLabel } from '../types.js'
import { StorageError } from '../errors.js'

/**
 * Splices a REAL constraint violation (a NOT NULL insert into `tasks`) right after the statement labelled
 * `after`, so a test proves the whole unit rolls back when a later statement fails. The fault is a statement,
 * not a thrown error: it fails inside the database, on whichever engine runs it.
 */
export function withFault<T>(op: PreparedOperation<T>, opts: { after: StatementLabel }): PreparedOperation<T> {
  return {
    ...op,
    name: `${op.name}+fault-after-${opts.after}`,
    build: (found, qc) => {
      const built = op.build(found, qc)
      const at = built.steps.findIndex((s) => s.label === opts.after)
      if (at < 0) throw new StorageError(`no statement labelled "${opts.after}" to fault after`)
      const fault = step(sql`insert into "tasks" ("id") values (null)`.compile(qc.db), 'fault')
      return unit({ ...built, steps: [...built.steps.slice(0, at + 1), fault, ...built.steps.slice(at + 1)] })
    },
  }
}
