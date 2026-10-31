import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'

// Never key_hash (a secret column: the type rejects it here), never the plaintext key: it exists only in the create response.
export const apiKeyRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  agent_id: z.uuid(),
  prefix: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ApiKeyRecord = z.infer<typeof apiKeyRecord>

/** Read-only here; `api_keys.create` and `api_keys.revoke` are hand-written (`admin/`). */
export const apiKeys = definePreparedResource({
  surface: 'meta',
  name: 'api_keys',
  eventName: 'api_key',
  table: 'api_keys',
  scopeResource: 'agents',
  operations: ['list', 'get'],
  record: apiKeyRecord,
  filters: { agent_id: { schema: z.uuid() } },
})
