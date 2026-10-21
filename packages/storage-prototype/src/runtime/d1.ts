import { ApiError } from '@vault/api'
import type { Miniflare } from 'miniflare'
import type { StorageRuntime, CompiledProgram, Execution } from '../types.js'
export function d1Runtime(mf: Miniflare, organizationId: string, route: 'a' | 'b'): StorageRuntime {
  return {
    async execute<T>(p: CompiledProgram<T>): Promise<Execution<T>> {
      if (p.dialect !== 'd1') throw new Error('wrong program dialect')
      if (p.context.organizationId !== organizationId)
        throw new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
      const start = performance.now()
      const response = await mf.dispatchFetch(`http://local/${route}`, {
        method: 'POST',
        body: JSON.stringify({
          context: { organizationId: p.context.organizationId },
          statements: p.statements,
        }),
      })
      const data = (await response.json()) as any
      if (!response.ok) throw new Error(data.error)
      if (data.results.length !== p.statements.length) throw new Error('batch result length mismatch')
      const rows = data.results[p.resultIndex].results
      const decoded = p.decode(rows)
      const meta = data.results.map((r: any) => r.meta)
      const sum = (key: string) =>
        meta.every((m: any) => typeof m?.[key] === 'number')
          ? meta.reduce((n: number, m: any) => n + m[key], 0)
          : null
      return {
        ...decoded,
        metrics: {
          statements: p.statements.length,
          physicalRequests: 1,
          setupRoundTrips: 0,
          lockRoundTrips: 0,
          resultRows: rows.length,
          rowsRead: sum('rows_read'),
          rowsWritten: sum('rows_written'),
          elapsedMs: performance.now() - start,
        },
      }
    },
  }
}
