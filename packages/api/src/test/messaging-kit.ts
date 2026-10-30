// Test-only ([[CORE25]] P9). Seeds a conversation (thread, message, attachments with their files, interaction,
// participants, provider sources) by DIRECT inserts through `insert(table, row)`, the established setup device
// ("bypassing the program under test"): the read-only messaging resources have no writer until cycle 2's
// `recordMessages`. Production code has none (D26). Every row satisfies the table CHECKs: a 64-character lowercase
// hex sha256, a preview of at most 200 characters, a content key on every `message` kind.
import { uuidv7 } from '@vault/storage'

/** `Engine.insert` or the contract kit's `insert`: fills `id`, `organization_id`, `created_by` and the stamps when omitted. */
export type Insert = (table: string, row: Record<string, unknown>) => Promise<Record<string, any>>

export interface AttachmentSpec {
  position: number
  /** A failed attachment has no file (`fetch_status 'failed'`, `file_id` null). */
  failed?: boolean
  inline?: boolean
  size_bytes?: number
  name?: string
}
export interface ConversationOpts {
  ids?: Partial<{ thread: string; message: string; interaction: string }>
  subject?: string | null
  externalId?: string
  inReplyTo?: string | null
  kind?: 'message' | 'reaction'
  /** A number n means n stored attachments at positions 0..n-1. */
  attachments?: number | readonly AttachmentSpec[]
  participants?: readonly { identityId: string; role: 'from' | 'to' | 'cc' | 'bcc' }[]
  direction?: 'inbound' | 'outbound'
  occurredAt?: string
  /** Reuse an existing thread (a second message of the same thread). */
  threadId?: string
  /** Default true. */
  interaction?: boolean
  /** The message's current version (default 1). */
  version?: number
}
export interface Conversation {
  organizationId: string
  threadId: string
  messageId: string
  interactionId: string | null
  /** The stored attachments' file ids, in the order given. */
  fileIds: string[]
  attachmentIds: string[]
  /** The message's `content_key` (D23: no trailing slash), null for a reaction. */
  contentKey: string | null
  /** The stored files' `storage_key`s, parallel to `fileIds`. */
  storageKeys: string[]
  messageSourceId: string
  threadSourceId: string | null
}

let counter = 0
const hex64 = (): string => (++counter).toString(16).padStart(64, '0')

export async function seedConversation(insert: Insert, opts: ConversationOpts = {}): Promise<Conversation> {
  const n = ++counter
  const occurredAt = opts.occurredAt ?? '2026-10-28T09:00:00.000Z'
  const kind = opts.kind ?? 'message'
  const thread = opts.threadId
    ? null
    : await insert('threads', { ...(opts.ids?.thread ? { id: opts.ids.thread } : {}), channel: 'email', subject: opts.subject === undefined ? `Subject ${n}` : opts.subject })
  const threadId = opts.threadId ?? (thread!.id as string)
  const organizationId = (thread?.organization_id as string | undefined) ?? ''
  const contentKey = kind === 'message' ? `orgs/${organizationId || 'org'}/messages/email/${hex64()}` : null
  const message = await insert('messages', {
    ...(opts.ids?.message ? { id: opts.ids.message } : {}),
    thread_id: threadId,
    channel: 'email',
    kind,
    external_id: opts.externalId ?? `m${n}@acme.test`,
    in_reply_to: opts.inReplyTo ?? null,
    author: { user_id: 'jane@acme.test', user_name: 'jane@acme.test', full_name: 'Jane', is_bot: false },
    occurred_at: occurredAt,
    preview: `Preview ${n}`,
    content_key: contentKey,
    version: opts.version ?? 1,
    retracted_at: null,
  })
  const specs: readonly AttachmentSpec[] =
    typeof opts.attachments === 'number' ? Array.from({ length: opts.attachments }, (_, position) => ({ position })) : (opts.attachments ?? [])
  const fileIds: string[] = []
  const storageKeys: string[] = []
  const attachmentIds: string[] = []
  for (const spec of specs) {
    let fileId: string | null = null
    if (!spec.failed) {
      const storageKey = `orgs/${organizationId || 'org'}/files/${uuidv7()}`
      const file = await insert('files', { name: spec.name ?? `file-${spec.position}.pdf`, mime_type: 'application/pdf', size_bytes: spec.size_bytes ?? 1000 + spec.position, sha256: hex64(), storage_key: storageKey })
      fileId = file.id as string
      fileIds.push(fileId)
      storageKeys.push(storageKey)
    }
    const att = await insert('message_attachments', {
      message_id: message.id,
      position: spec.position,
      file_id: fileId,
      type: 'file',
      name: spec.name ?? `file-${spec.position}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: spec.size_bytes ?? 1000 + spec.position,
      inline: spec.inline ?? false,
      content_id: null,
      fetch_status: spec.failed ? 'failed' : 'stored',
      fetch_metadata: null,
      fetch_error: spec.failed ? 'not found' : null,
    })
    attachmentIds.push(att.id as string)
  }
  let interactionId: string | null = null
  if (opts.interaction !== false) {
    const interaction = await insert('interactions', {
      ...(opts.ids?.interaction ? { id: opts.ids.interaction } : {}),
      kind,
      channel: 'email',
      direction: opts.direction ?? 'inbound',
      occurred_at: occurredAt,
      thread_id: threadId,
      message_id: message.id,
    })
    interactionId = interaction.id as string
    for (const p of opts.participants ?? []) await insert('interaction_participants', { interaction_id: interactionId, identity_id: p.identityId, role: p.role })
  }
  const source = await insert('message_sources', { message_id: message.id, connection_id: uuidv7(), provider_message_id: `gm-${n}`, provider_thread_id: `gt-${n}` })
  const tsource = thread ? await insert('thread_sources', { thread_id: threadId, connection_id: uuidv7(), provider_thread_id: `gt-${n}` }) : null
  return {
    organizationId: (message.organization_id as string | undefined) ?? organizationId,
    threadId,
    messageId: message.id as string,
    interactionId,
    fileIds,
    attachmentIds,
    contentKey,
    storageKeys,
    messageSourceId: source.id as string,
    threadSourceId: tsource ? (tsource.id as string) : null,
  }
}
