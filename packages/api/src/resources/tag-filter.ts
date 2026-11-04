import { sql } from 'kysely'
import { z } from 'zod'
import type { JoinFilter } from '../storage/definition.js'

/**
 * The `tag_id` list filter ([[CORE129]] D9, D12) of a taggable table: an `EXISTS` over a live `associations` edge between the tag and the
 * row, matching either canonical side (`tags` sorts before `tasks` and after `companies`, `contacts` and `notes`, so the tag is `a` for tasks
 * and `b` for the others, but the predicate does not assume it). Using it needs `tags:read` and `associations:read` (hop-by-hop visibility).
 * `table` is a registry table name, never input.
 */
export const tagIdFilter = (table: string): JoinFilter => ({
  schema: z.uuid(),
  normalize: (v) => (v as string).toLowerCase(),
  requires: [
    { resource: 'tags', action: 'read' },
    { resource: 'associations', action: 'read' },
  ],
  where: (_qc, value) => {
    const T = (c: string) => sql.ref(`${table}.${c}`)
    const tagOnA = sql`("x"."a_type" = 'tags' and "x"."a_id" = ${value as string} and "x"."b_type" = ${table} and "x"."b_id" = ${T('id')})`
    const tagOnB = sql`("x"."b_type" = 'tags' and "x"."b_id" = ${value as string} and "x"."a_type" = ${table} and "x"."a_id" = ${T('id')})`
    return sql<boolean>`exists (select 1 from "associations" as "x" where "x"."organization_id" = ${T('organization_id')} and "x"."deleted_at" is null and (${tagOnA} or ${tagOnB}))`
  },
})
