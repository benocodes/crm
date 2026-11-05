import { sql } from 'kysely'
import { z } from 'zod'
import type { JoinFilter } from '../storage/definition.js'

/**
 * A "linked to this record" list filter ([[CORE129]] D9, D12; [[CORE130]] D15): an `EXISTS` over a live `associations` edge between a record of
 * `otherType` and the row, matching either canonical side (the pair is ordered by type name, so which end the row is on depends on the pair, and the
 * predicate does not assume it). Using it needs the read scope of `otherType` and `associations:read` (hop-by-hop visibility).
 * `table` and `otherType` are registry table names, never input.
 */
export const linkedToFilter = (table: string, otherType: string, description?: string): JoinFilter => ({
  schema: description ? z.uuid().describe(description) : z.uuid(),
  normalize: (v) => (v as string).toLowerCase(),
  requires: [
    { resource: otherType, action: 'read' },
    { resource: 'associations', action: 'read' },
  ],
  where: (_qc, value) => {
    const T = (c: string) => sql.ref(`${table}.${c}`)
    const otherOnA = sql`("x"."a_type" = ${otherType} and "x"."a_id" = ${value as string} and "x"."b_type" = ${table} and "x"."b_id" = ${T('id')})`
    const otherOnB = sql`("x"."b_type" = ${otherType} and "x"."b_id" = ${value as string} and "x"."a_type" = ${table} and "x"."a_id" = ${T('id')})`
    return sql<boolean>`exists (select 1 from "associations" as "x" where "x"."organization_id" = ${T('organization_id')} and "x"."deleted_at" is null and (${otherOnA} or ${otherOnB}))`
  },
})

/** The `tag_id` filter of a taggable table. */
export const tagIdFilter = (table: string): JoinFilter => linkedToFilter(table, 'tags')
