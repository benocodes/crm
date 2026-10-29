import type { Generated, Insertable, Selectable, Updateable } from 'kysely'
import type { DB, Identities, InteractionParticipants, Interactions, MessageAttachments, Messages, Memberships, Principals, Tasks, Threads } from './types.generated.js'

// Narrowed columns. A defaulted column keeps `Generated<>` inside the override, or every insert
// relying on the default stops compiling.
export type Database = Omit<DB, 'principals' | 'memberships' | 'tasks' | 'identities' | 'threads' | 'messages' | 'interactions' | 'interaction_participants' | 'message_attachments'> & {
  principals: Omit<Principals, 'kind'> & { kind: 'user' | 'agent' | 'system' }
  memberships: Omit<Memberships, 'role'> & { role: 'owner' | 'member' }
  tasks: Omit<Tasks, 'status'> & { status: Generated<'open' | 'done'> }
  identities: Omit<Identities, 'kind'> & { kind: 'email' | 'phone' }
  // Messaging (CORE25): literal vocabularies, no Generated<> (no column here has a default).
  threads: Omit<Threads, 'channel'> & { channel: 'email' }
  messages: Omit<Messages, 'channel' | 'kind'> & { channel: 'email'; kind: 'message' | 'reaction' }
  interactions: Omit<Interactions, 'kind' | 'channel' | 'direction'> & { kind: 'message' | 'reaction'; channel: 'email'; direction: 'inbound' | 'outbound' }
  interaction_participants: Omit<InteractionParticipants, 'role'> & { role: 'from' | 'to' | 'cc' | 'bcc' }
  message_attachments: Omit<MessageAttachments, 'type' | 'fetch_status'> & { type: 'image' | 'file' | 'video' | 'audio'; fetch_status: 'stored' | 'pending' | 'failed' | 'skipped' }
}

export type { Insertable, Selectable, Updateable }
