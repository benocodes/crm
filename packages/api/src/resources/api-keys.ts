import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

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

/**
 * The record and the list grammar of the key operations ([[CORE351]]): not a registered resource (the four operations are control operations, `admin/api-keys.ts`), but the one source of the list's query parameters,
 * sorts, filters and their parser, and of the request and response shapes of `list` and `get`.
 */
export const apiKeys = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      notProposable: 'credentials are not proposable',
      surface: 'meta',
      name: 'api_keys',
      eventName: 'api_key',
      table: 'api_keys',
      scopeResource: 'agents',
      operations: ['list', 'get'],
      record: apiKeyRecord,
      filters: { agent_id: { schema: z.uuid() } },
    }),
    ['last_used_at', 'expires_at'],
  ),
)
