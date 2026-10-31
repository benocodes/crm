import { z } from 'zod'
import { COLUMN_KINDS, type ColumnKind } from '@vault/storage'
import type { Scope } from '../scopes.js'
import { scopeResourceOf } from '../resources/define.js'
import { definePreparedResource, type PreparedResource } from '../storage/definition.js'

/**
 * The `associations` rows as a prepared definition ([[CORE62]] D12): the record, the table and the event name. It is NOT
 * registered as a generic resource (no generated CRUD): the four operations are hand-written because their shapes differ
 * (canonicalised create, oriented list, endpoint-aware reads). The definition serves their reads, events and the cascades.
 */
export const associations = definePreparedResource({
  surface: 'api',
  name: 'associations',
  eventName: 'association',
  table: 'associations',
  scopeResource: 'associations',
  operations: [],
  record: z.object({
    id: z.uuid(),
    a_type: z.string(),
    a_id: z.uuid(),
    b_type: z.string(),
    b_id: z.uuid(),
    relation: z.enum(['related_to']),
    created_by: z.uuid(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
})
export type AssociationRecord = { id: string; a_type: string; a_id: string; b_type: string; b_id: string; relation: 'related_to'; created_by: string; created_at: string; updated_at: string }

/** One allowed endpoint type: a table of the registry whose definition says `associable: true`. */
export interface EndpointType {
  /** The table name: stored in `a_type`/`b_type`, and the only text that ever reaches SQL as an identifier. */
  readonly type: string
  /** The read scope needed to see rows of the type (a thread's is `messages:read`). */
  readonly read: Scope
  /** Whether rows have `organization_id` / `deleted_at` (threads and interactions have no `deleted_at`: they are live when they exist). */
  readonly hasOrganization: boolean
  readonly softDeletes: boolean
}

export type EndpointTypes = ReadonlyMap<string, EndpointType>

/** The associable set, derived from the definitions: the registry is the one list of allowed types (D4, D9). */
export function endpointTypesOf(defs: readonly PreparedResource<any, any>[]): EndpointTypes {
  const out = new Map<string, EndpointType>()
  for (const def of defs) {
    if (!def.associable) continue
    const kinds = COLUMN_KINDS[def.table as keyof typeof COLUMN_KINDS] as Record<string, ColumnKind>
    out.set(def.table, { type: def.table, read: { resource: scopeResourceOf(def), action: 'read' }, hasOrganization: 'organization_id' in kinds, softDeletes: 'deleted_at' in kinds })
  }
  return out
}

/** Canonical order of two endpoints ([[CORE62]] D2): by type, then id (ASCII lowercase UUIDs, so code-unit order is byte order). */
export type Endpoint = { type: string; id: string }
export const isBefore = (x: Endpoint, y: Endpoint): boolean => x.type < y.type || (x.type === y.type && x.id < y.id)
