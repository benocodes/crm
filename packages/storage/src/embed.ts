import { sql, type RawBuilder } from 'kysely'
import type { PhysicalTable } from './database.js'
import type { QueryContext } from './types.js'

// STUB (red phase): replaced by the real implementation in Phase 3.
export interface EmbedSpec {
  readonly table: PhysicalTable
  readonly key: string
  readonly columns: readonly string[]
  readonly orderBy: readonly string[]
}
export function embedJson(_qc: QueryContext, _parent: PhysicalTable, _spec: EmbedSpec, _ctx: 'select' | 'json'): RawBuilder<unknown> {
  return sql`null`
}
