import { postgresFixture } from './postgres.js'
import { d1Fixture } from './d1.js'
import { postgresRuntime } from '../runtime/postgres.js'
import { d1Runtime } from '../runtime/d1.js'
import { prepareTaskUpdate, prepareResolveIdentities } from '../prepare.js'
import { compileOperation } from '../compile.js'
import { uuid7 } from '../uuid7.js'
import type { ExecutionContext, CompiledProgram } from '../types.js'
export const backends = ['postgres', 'd1'] as const
export type Backend = (typeof backends)[number]
export async function harness(backend: Backend) {
  const f = backend === 'postgres' ? await postgresFixture() : await d1Fixture()
  const runtime =
    backend === 'postgres'
      ? postgresRuntime((f as Awaited<ReturnType<typeof postgresFixture>>).db)
      : d1Runtime((f as Awaited<ReturnType<typeof d1Fixture>>).mf, f.a.organizationId, 'a')
  const preparation = () => ({ operationId: uuid7(), now: new Date().toISOString(), nextId: uuid7 })
  const compileTask = (id: string, patch: unknown, context: ExecutionContext = f.a, now?: string) =>
    compileOperation(
      prepareTaskUpdate(context, { id, patch }, { ...preparation(), ...(now ? { now } : {}) }),
      backend,
    )
  const compileResolve = (entries: any[], context: ExecutionContext = f.a) =>
    compileOperation(prepareResolveIdentities(context, entries, preparation()), backend)
  return {
    ...f,
    backend,
    runtime,
    compileTask,
    compileResolve,
    task: async (id: string, patch: unknown, context: ExecutionContext = f.a) =>
      runtime.execute(compileTask(id, patch, context)),
    resolve: async (entries: any[], context: ExecutionContext = f.a) =>
      runtime.execute(compileResolve(entries, context)),
    counts: async () => {
      const tables = [
        'tasks',
        'contacts',
        'identities',
        'events',
        'principals',
        backend === 'postgres' ? 'storage_prototype.operations' : 'prototype_operations',
        backend === 'postgres' ? 'storage_prototype.rows' : 'prototype_rows',
      ]
      const counts: Record<string, number> = {}
      for (const t of tables) counts[t] = Number((await f.query(`SELECT count(*) as n FROM ${t}`))[0].n)
      return counts
    },
    events: async () =>
      (await f.query('SELECT * FROM events')).map((r) => ({
        ...r,
        before: typeof r.before === 'string' ? JSON.parse(r.before) : r.before,
        after: typeof r.after === 'string' ? JSON.parse(r.after) : r.after,
      })),
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>
export function fault<T>(p: CompiledProgram<T>, label: string): CompiledProgram<T> {
  const statements = [...p.statements]
  const i = statements.findIndex((s) => s.label === label)
  if (i < 0) throw new Error('missing stage ' + label)
  // NOT NULL violation in both engines, independent of SQLite division semantics.
  statements.splice(i + 1, 0, {
    label: 'fault',
    sql: `INSERT INTO ${p.dialect === 'postgres' ? 'storage_prototype.operations' : 'prototype_operations'} (id) VALUES (NULL)`,
    parameters: [],
  })
  return { ...p, statements, resultIndex: statements.findIndex((s) => s.label === 'result') }
}
