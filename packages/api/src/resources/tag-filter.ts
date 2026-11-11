import { sql } from 'kysely'
import { z } from 'zod'
import type { CustomFilter } from '../storage/definition.js'

/**
 * A "linked to this record" list filter ([[CORE129]] D9, D12; [[CORE130]] D15): an `EXISTS` over a live `associations` edge between a record of
 * `otherType` and the row, matching either canonical side (the pair is ordered by type name, so which end the row is on depends on the pair, and the
 * predicate does not assume it). Using it needs the read scope of `otherType` and `associations:read` (hop-by-hop visibility).
 * `table` and `otherType` are registry table names, never input.
 */
export const linkedToFilter = (table: string, otherType: string, description?: string): CustomFilter => ({
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
export const tagIdFilter = (table: string): CustomFilter => linkedToFilter(table, 'tags', 'Only rows linked to this tag (an association). Needs tags:read and associations:read.')

/**
 * [[CORE199]] D7: `tag=<name>` keeps rows linked to the live tag of exactly that name (trimmed and case-sensitive: the column's NOCASE collation would match `Consultancy` to `consultancy`, so the comparison names BINARY).
 * The same live-association `EXISTS` as `tag_id`, joined to `tags` on the name inside the predicate, so there is no extra round-trip; an unknown name
 * matches nothing. Needs `tags:read` and `associations:read`, as `tag_id` does ([[CORE129]] D12). `table` is a registry table name, never input.
 */
export const tagNameFilter = (table: string): CustomFilter => ({
  schema: z.string().trim().min(1).max(100).describe('Only rows linked to the live tag with exactly this name (trimmed, case-sensitive: unlike tags?name=, which folds ASCII case). An unknown name gives an empty page. Needs tags:read and associations:read.'),
  requires: [
    { resource: 'tags', action: 'read' },
    { resource: 'associations', action: 'read' },
  ],
  where: (qc, value) => {
    const T = (c: string) => sql.ref(`${table}.${c}`)
    const exact = sql.raw(qc.dialect === 'd1' ? 'collate binary' : 'collate "C"')
    const tagOnA = sql`("x"."a_type" = 'tags' and "x"."a_id" = "t"."id" and "x"."b_type" = ${table} and "x"."b_id" = ${T('id')})`
    const tagOnB = sql`("x"."b_type" = 'tags' and "x"."b_id" = "t"."id" and "x"."a_type" = ${table} and "x"."a_id" = ${T('id')})`
    return sql<boolean>`exists (select 1 from "associations" as "x" join "tags" as "t" on "t"."organization_id" = "x"."organization_id" and "t"."deleted_at" is null and "t"."name" = ${value as string} ${exact} where "x"."organization_id" = ${T('organization_id')} and "x"."deleted_at" is null and (${tagOnA} or ${tagOnB}))`
  },
})
