import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'

/**
 * Read-only ([[CORE25]] D26), `files:read`: the file's metadata. `storage_key` is not in the record (the bytes are
 * served by the content operation of [[CORE58]]). `size_bytes` is a JSON number on both engines (Postgres stores bigint).
 */
export const files = definePreparedResource({
  surface: 'api',
  name: 'files',
  eventName: 'file',
  table: 'files',
  scopeResource: 'files',
  operations: ['list', 'get'],
  record: z.object({
    id: z.uuid(),
    name: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    sha256: z.string(),
    created_by: z.uuid(),
    created_at: z.string(),
  }),
  filters: { sha256: { schema: z.string().regex(/^[0-9a-fA-F]{64}$/), normalize: (v) => (v as string).toLowerCase() } },
})
