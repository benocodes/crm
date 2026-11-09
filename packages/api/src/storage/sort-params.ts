import { z } from 'zod'
import type { PreparedResource } from './definition.js'

// The query and response typing of a sorted list ([[CORE133]] D8, D9), shared by the generated list (registry.ts) and by a hand-written list that
// adopted the foundation ([[CORE188]]: action_executions), so the parameter text and the opaque cursor types have one source.

export const SORTED_AFTER = z
  .string()
  .describe('Opaque cursor: pass the next_cursor of the previous page back unchanged. With sort it must come from a page with the same sort and order; without sort it is the id of the last record.')
export const SORTED_NEXT = z.string().nullable().describe('Opaque cursor for the next page, or null at the end. Pass it back as after, with the same sort and order.')
/** The `sort` parameter text, with the cursor-stability caveat ([[CORE133]] D9). */
export const sortDescription = (def: Pick<PreparedResource<any, any>, 'sorts' | 'sortNote'>): string =>
  `Sort by ${(def.sorts ?? []).join(' or ')}. Stored columns need only this list's read scope; derived fields need the scopes that show them. null sorts as the lowest value: first in asc, last in desc. Ties break on id in the same direction. ` +
  `Newest first: sort=created_at&order=desc; for mail use sort=occurred_at&order=desc. Without sort the list is in ascending id order with UUID cursors. ` +
  `Paging is by keyset, not a snapshot: values can rise between pages (or fall), so a record may repeat in asc or be missed in desc. In descending mail date order, newly arrived mail ahead of the cursor is not seen; backfilled older mail behind it is. ` +
  `A complete walk uses the default order. An incremental walk also uses the default ascending id order. Mail created_at uses a temporary sort over the workspace's rows; id is indexed and follows capture order.` +
  (def.sortNote === undefined ? '' : ` ${def.sortNote}`)

/** The `after`, `sort` and `order` query fields of a sorted list, with the opaque-cursor typing; the caller adds `limit` and its filters. */
export function sortedQueryFields(def: Pick<PreparedResource<any, any>, 'sorts' | 'sortNote'>): Record<string, z.ZodType> {
  return {
    after: SORTED_AFTER.optional(),
    sort: z.enum((def.sorts ?? []) as [string, ...string[]]).describe(sortDescription(def)).optional(),
    order: z.enum(['asc', 'desc']).describe('Sort direction: asc (default) or desc. Needs sort.').optional(),
  }
}
