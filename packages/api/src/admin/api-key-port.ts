// The narrow port the four `api_keys.*` operations reach the control plane's `api_keys` through ([[CORE351]] P5, [[CORE259]] D5), with its own types: nothing in this package imports the control plane's
// store. Composition builds it over the store's key methods and hands it in (a structural fit, checked where it is assigned). Without it (`null`) the operations answer `501 provider_not_configured`. A create or
// revoke is one control batch with its `control_audit` row (the store's job). Timestamps are ISO-8601 text.

export interface ApiKeyStoreRecord {
  id: string
  organizationId: string
  agentId: string
  prefix: string
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}
export type ApiKeyStoreColumn =
  | 'id'
  | 'agent_id'
  | 'prefix'
  | 'last_used_at'
  | 'revoked_at'
  | 'expires_at'
  | 'created_by'
  | 'created_at'
  | 'updated_at'
/** One parsed column condition: `value` is the stored form; `glob` and `like` carry a finished pattern; `null` is `IS NULL`. */
export type ApiKeyStoreFilter = { column: ApiKeyStoreColumn; not: boolean } & (
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'glob' | 'like'; value: string }
  | { op: 'in'; value: readonly string[] }
  | { op: 'null' }
)
export interface ApiKeyStoreSort {
  column: 'id' | 'created_at' | 'updated_at' | 'last_used_at' | 'expires_at'
  order: 'asc' | 'desc'
  position: { value: string | null; id: string } | null
}
export interface ApiKeyStorePort {
  /** `duplicate`: the id or hash exists; neither row was written. */
  create(a: {
    id: string
    auditId: string
    actorId: string
    organizationId: string
    agentId: string
    keyHash: string
    prefix: string
    expiresAt: string | null
    now: string
  }): Promise<'created' | 'duplicate'>
  /** `drifted`: the row moved since `expectedUpdatedAt`; nothing was written. */
  revoke(a: {
    id: string
    organizationId: string
    auditId: string
    actorId: string
    now: string
    expectedUpdatedAt?: string
  }): Promise<'revoked' | 'already_revoked' | 'not_found' | 'drifted'>
  get(a: { id: string; organizationId: string }): Promise<ApiKeyStoreRecord | null>
  list(a: {
    organizationId: string
    filters?: readonly ApiKeyStoreFilter[]
    after?: string
    sort?: ApiKeyStoreSort
    limit: number
  }): Promise<ApiKeyStoreRecord[]>
}
