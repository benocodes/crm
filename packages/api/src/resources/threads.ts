import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'

/**
 * Read-only ([[CORE25]] D26): threads are written by capture programs only (cycle 2), never by a REST route. A thread has
 * no `deleted_at` (D45), so the generic core adds no live-row condition and generates no delete. Its scope is
 * `messages:read` (D25: threads are part of content).
 */
export const threads = definePreparedResource({
  name: 'threads',
  eventName: 'thread',
  table: 'threads',
  associable: true,
  scopeResource: 'messages',
  operations: ['list', 'get'],
  record: z.object({
    id: z.uuid(),
    channel: z.enum(['email']),
    subject: z.string().nullable(),
    created_by: z.uuid(),
    created_at: z.string(),
  }),
  filters: { channel: { schema: z.enum(['email']) } },
})
