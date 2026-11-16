import { z } from 'zod'
import type { ColumnKind } from '@vibase/storage'
import { defineGrammarResource } from '../storage/definition.js'
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
 * The sortable and filterable columns of a key and their kinds ([[CORE329]] P4): the grammar names no CRM table (`api_keys` lives in the control plane). `key_hash` is absent on purpose: it can be neither sorted nor filtered.
 * The control suites (`control-api-keys`, `control-schema`) pin the live table these describe.
 */
export const API_KEY_COLUMN_KINDS = {
  id: 'uuid',
  created_at: 'timestamp',
  updated_at: 'timestamp',
  organization_id: 'uuid',
  agent_id: 'uuid',
  prefix: 'text',
  last_used_at: 'timestamp',
  revoked_at: 'timestamp',
  expires_at: 'timestamp',
  created_by: 'uuid',
} as const satisfies Record<string, ColumnKind>

/**
 * The record and the list grammar of the key operations ([[CORE351]]): not a registered resource (the four operations are control operations, `admin/api-keys.ts`), but the one source of the list's query parameters,
 * sorts, filters and their parser, and of the request and response shapes of `list` and `get`.
 */
export const apiKeys = withColumnFilters(
  withColumnSorts(
    defineGrammarResource({
      notProposable: 'credentials are not proposable',
      surface: 'meta',
      name: 'api_keys',
      // Required by the definition type; nothing emits it and it is not in the event-type map ([[CORE357]]): key changes are audit rows (`audit.list`), not events.
      eventName: 'api_key',
      table: 'api_keys',
      columnKinds: API_KEY_COLUMN_KINDS,
      scopeResource: 'agents',
      operations: ['list', 'get'],
      record: apiKeyRecord,
      filters: { agent_id: { schema: z.uuid() } },
    }),
    ['last_used_at', 'expires_at'],
  ),
)
