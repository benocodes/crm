import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

/**
 * Read-only ([[CORE25]] D26): threads are written by capture programs only (cycle 2), never by a REST route. A thread has
 * no `deleted_at` (D45), so the generic core adds no live-row condition and generates no delete. Its scope is
 * `messages:read_metadata` ([[API516]] D7: a thread's subject is the subject level; its content stays behind `messages:read`).
 */
export const threads = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      surface: 'api',
      name: 'threads',
      eventName: 'thread',
      table: 'threads',
      associable: true,
      scopeResource: 'messages',
      readAction: 'read_metadata',
      operations: ['list', 'get'],
      record: z.object({
        id: z.uuid(),
        channel: z.enum(['email', 'form']),
        subject: z.string().nullable(),
        created_by: z.uuid(),
        created_at: z.string(),
      }),
      filters: { channel: { schema: z.enum(['email', 'form']) } },
    }),
    ['subject'],
  ),
)
