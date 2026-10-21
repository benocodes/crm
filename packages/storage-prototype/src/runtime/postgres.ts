import { CompiledQuery, sql, type Kysely } from 'kysely'
import { withOrganization, type Database } from '@vault/db'
import { lockKeys } from '@vault/api'
import type { StorageRuntime, CompiledProgram, Execution } from '../types.js'
export function postgresRuntime(db: Kysely<Database>): StorageRuntime {
  return {
    async execute<T>(p: CompiledProgram<T>): Promise<Execution<T>> {
      if (p.dialect !== 'postgres') throw new Error('wrong program dialect')
      const start = performance.now()
      let locks = 0
      const rows = await withOrganization(
        db,
        { organizationId: p.context.organizationId, principalId: p.context.actor.id },
        async (trx) => {
          const keys = p.locks.flatMap((l) => ('key' in l ? [l.key] : []))
          if (keys.length) {
            await lockKeys(trx, keys)
            locks++
          }
          for (const lock of p.locks)
            if ('table' in lock) {
              await sql`SELECT id FROM ${sql.table(lock.table)}
                WHERE id=${lock.id} AND organization_id=${p.context.organizationId} FOR UPDATE`.execute(trx)
              locks++
            }
          let result: Record<string, any>[] = []
          for (const [index, s] of p.statements.entries()) {
            const r = await trx.executeQuery<Record<string, any>>(CompiledQuery.raw(s.sql, s.parameters))
            if (index === p.resultIndex) result = r.rows
          }
          return result
        },
      )
      const decoded = p.decode(rows)
      return {
        ...decoded,
        metrics: {
          statements: p.statements.length,
          physicalRequests: p.statements.length + 4 + locks,
          setupRoundTrips: 4,
          lockRoundTrips: locks,
          resultRows: rows.length,
          rowsRead: null,
          rowsWritten: null,
          elapsedMs: performance.now() - start,
        },
      }
    },
  }
}
