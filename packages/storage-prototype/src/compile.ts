import type { PreparedOperation, CompiledProgram } from './types.js'
import { SqlKit } from './sql-kit.js'
import { taskUpdate } from './operations/task-update.js'
import { resolveIdentitiesProgram } from './operations/resolve-identities.js'
import { decodeTask, decodeResolve } from './codecs.js'
/** Dispatch selects one shared definition; backend syntax is confined to SqlKit. */
export function compileOperation<T>(
  op: PreparedOperation<T>,
  dialect: 'postgres' | 'd1',
): CompiledProgram<T> {
  const k = new SqlKit(dialect, op)
  k.begin()
  if (op.kind === 'task') taskUpdate(k)
  else resolveIdentitiesProgram(k)
  const resultIndex = k.statements.findIndex((s) => s.label === 'result')
  k.cleanup()
  return {
    context: op.context,
    dialect,
    statements: k.statements,
    resultIndex,
    locks: op.locks,
    decode: (op.kind === 'task' ? decodeTask : decodeResolve) as CompiledProgram<T>['decode'],
  }
}
