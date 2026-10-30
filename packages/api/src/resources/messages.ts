import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'

/** The SDK `Author` in snake case without `is_me` ([[CORE25]]): for mail `user_id` is the address as written. */
const author = z.object({ user_id: z.string(), user_name: z.string(), full_name: z.string(), is_bot: z.boolean() })

/** An attachment as the message embeds it (D50): metadata only. `storage_key`, `fetch_metadata` and `fetch_error` stay in the database. */
const attachment = z.object({
  id: z.uuid(),
  position: z.number().int(),
  type: z.enum(['image', 'file', 'video', 'audio']),
  name: z.string().nullable(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().int().nullable(),
  inline: z.boolean(),
  content_id: z.string().nullable(),
  fetch_status: z.enum(['stored', 'pending', 'failed', 'skipped']),
  file_id: z.uuid().nullable(),
})

/**
 * Read-only ([[CORE25]] D26), `messages:read`. `content_key` is not in the record (the content operation is cycle
 * [[CORE58]]'s), and attachments are embedded ordered by position, `[]` when there are none.
 */
export const messages = definePreparedResource({
  name: 'messages',
  eventName: 'message',
  table: 'messages',
  scopeResource: 'messages',
  operations: ['list', 'get'],
  record: z.object({
    id: z.uuid(),
    thread_id: z.uuid(),
    channel: z.enum(['email']),
    kind: z.enum(['message', 'reaction']),
    external_id: z.string(),
    in_reply_to: z.string().nullable(),
    author,
    occurred_at: z.string(),
    preview: z.string(),
    version: z.number().int(),
    retracted_at: z.string().nullable(),
    attachments: z.array(attachment),
    created_by: z.uuid(),
    created_at: z.string(),
  }),
  embed: {
    attachments: {
      table: 'message_attachments',
      key: 'message_id',
      columns: ['id', 'position', 'type', 'name', 'mime_type', 'size_bytes', 'inline', 'content_id', 'fetch_status', 'file_id'],
      orderBy: ['position'],
    },
  },
  filters: {
    thread_id: { schema: z.uuid(), normalize: (v) => (v as string).toLowerCase() },
    channel: { schema: z.enum(['email']) },
    kind: { schema: z.enum(['message', 'reaction']) },
    external_id: { schema: z.string().min(1).max(998) },
    in_reply_to: { schema: z.string().min(1).max(998) },
  },
})
