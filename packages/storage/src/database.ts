import type { ColumnType, Selectable, UpdateType } from 'kysely'

/**
 * The portable table types ([[CORE35]]): what the typed builders see on BOTH engines. They model the real
 * driver differences instead of hiding them: a timestamp is read as `Date` (Postgres) or text (D1) and is
 * always written as ISO-8601 UTC text; ids are minted by the application (D9), so no column is `Generated`.
 * Postgres' generated types stay authoritative for its own connection; the parity tests bind these types to
 * the physical schemas (storage-postgres and storage-d1 each have one).
 */
export type Timestamp = ColumnType<Date | string, string, string>
export type NullableTimestamp = ColumnType<Date | string | null, string | null, string | null>
/** JSON as read: an object (Postgres jsonb) or text (D1); written as JSON text. */
export type JsonValue = ColumnType<unknown, string | null, string | null>
/** A boolean as read: `boolean` (Postgres) or 0/1 (D1); written as a boolean (the D1 runtime encodes it 1/0). */
export type BooleanColumn = ColumnType<boolean | number, boolean, boolean>
/**
 * A text array: Postgres `text[]`, D1 a JSON array of text (the runtime encodes a JS array on write, and `toRecord`
 * decodes on read). The column type models the DECODED value (`string[]`), like the public record does, so a record
 * that mistypes the column (`z.string()`) is a compile error; the raw D1 text never reaches a typed consumer.
 */
export type StringArrayColumn = ColumnType<string[], readonly string[], readonly string[]>

/**
 * An integer as the DECODED number (CORE25 P5): Postgres `integer` and `bigint` (`pg` returns bigint as text, decoded in
 * `toRecord`), D1 `INTEGER`. Written as a JS number; a byte size above 2^53 is refused by the codec.
 */
export type IntegerColumn = ColumnType<number, number, number>
export type NullableIntegerColumn = ColumnType<number | null, number | null, number | null>

export interface OrganizationsTable {
  id: string
  name: string
  auth_provider: string | null
  auth_org_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}
export interface PrincipalsTable {
  id: string
  kind: 'user' | 'agent' | 'system'
  created_at: Timestamp
}
export interface EventsTable {
  id: string
  created_at: Timestamp
  organization_id: string
  type: string
  resource_type: string
  resource_id: string
  actor_id: string
  before: JsonValue
  after: JsonValue
}
export interface TasksTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  title: string
  notes: string | null
  status: 'open' | 'done'
  due_at: NullableTimestamp
  completed_at: NullableTimestamp
  assignee_id: string | null
  created_by: string
  deleted_at: NullableTimestamp
}
export interface CompaniesTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  created_by: string
  deleted_at: NullableTimestamp
  name: string
  domain: string | null
}
export interface ContactsTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  created_by: string
  deleted_at: NullableTimestamp
  name: string | null
  company_id: string | null
  merged_into_id: string | null
}
export interface IdentitiesTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  created_by: string
  deleted_at: NullableTimestamp
  kind: 'email' | 'phone'
  value: string
  contact_id: string | null
  own: BooleanColumn
}
export interface UsersTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  email: string
  name: string | null
  auth_provider: string | null
  auth_subject: string | null
  email_verified: BooleanColumn
}
export interface MembershipsTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  user_id: string
  role: 'owner' | 'member'
  created_by: string
  deleted_at: NullableTimestamp
}
export interface AgentsTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  name: string
  scopes: StringArrayColumn
  disabled_at: NullableTimestamp
  created_by: string
}
export interface ApiKeysTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  agent_id: string
  key_hash: string
  prefix: string
  last_used_at: NullableTimestamp
  revoked_at: NullableTimestamp
  expires_at: NullableTimestamp
  created_by: string
}


// ---- the messaging model (CORE25 D44): capture tables are append-only, the two link tables are soft-deleted ----------
export interface ThreadsTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  channel: 'email'
  subject: string | null
}
export interface MessagesTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  thread_id: string
  channel: 'email'
  kind: 'message' | 'reaction'
  external_id: string
  in_reply_to: string | null
  author: JsonValue
  occurred_at: Timestamp
  preview: string
  content_key: string | null
  version: IntegerColumn
  retracted_at: NullableTimestamp
}
export interface InteractionsTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  kind: 'message' | 'reaction'
  channel: 'email'
  direction: 'inbound' | 'outbound'
  occurred_at: Timestamp
  thread_id: string | null
  message_id: string | null
}
export interface FilesTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  name: string
  mime_type: string
  size_bytes: IntegerColumn
  sha256: string
  storage_key: string
}
export interface ContactFilesTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  created_by: string
  deleted_at: NullableTimestamp
  contact_id: string
  file_id: string
}
export interface CompanyFilesTable {
  id: string
  created_at: Timestamp
  updated_at: Timestamp
  organization_id: string
  created_by: string
  deleted_at: NullableTimestamp
  company_id: string
  file_id: string
}
export interface InteractionParticipantsTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  interaction_id: string
  identity_id: string
  role: 'from' | 'to' | 'cc' | 'bcc'
}
export interface MessageAttachmentsTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  message_id: string
  position: IntegerColumn
  file_id: string | null
  type: 'image' | 'file' | 'video' | 'audio'
  name: string | null
  mime_type: string | null
  size_bytes: NullableIntegerColumn
  inline: BooleanColumn
  content_id: string | null
  fetch_status: 'stored' | 'pending' | 'failed' | 'skipped'
  fetch_metadata: JsonValue
  fetch_error: string | null
}
export interface MessageSourcesTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  message_id: string
  connection_id: string
  provider_message_id: string
  provider_thread_id: string
}
export interface ThreadSourcesTable {
  id: string
  created_at: Timestamp
  organization_id: string
  created_by: string
  thread_id: string
  connection_id: string
  provider_thread_id: string
}

export interface StorageDatabase {
  organizations: OrganizationsTable
  principals: PrincipalsTable
  events: EventsTable
  tasks: TasksTable
  companies: CompaniesTable
  contacts: ContactsTable
  identities: IdentitiesTable
  users: UsersTable
  memberships: MembershipsTable
  agents: AgentsTable
  api_keys: ApiKeysTable
  threads: ThreadsTable
  messages: MessagesTable
  interactions: InteractionsTable
  files: FilesTable
  contact_files: ContactFilesTable
  company_files: CompanyFilesTable
  interaction_participants: InteractionParticipantsTable
  message_attachments: MessageAttachmentsTable
  message_sources: MessageSourcesTable
  thread_sources: ThreadSourcesTable
}

export type Table = keyof StorageDatabase & string
export type RowOf<T extends Table> = Selectable<StorageDatabase[T]>
export type ColumnOf<T extends Table> = keyof RowOf<T> & string
/** The value a column accepts in a predicate or an update. */
export type ValueOf<T extends Table, C extends ColumnOf<T>> = UpdateType<StorageDatabase[T][C & keyof StorageDatabase[T]]>

/** Columns that must never appear in a public projection, per table. */
export interface SecretColumns {
  api_keys: 'key_hash'
  /** [[CORE25]] D23: the object keys never appear in a read schema; the content operations read them with `selectColumns`. */
  messages: 'content_key'
  files: 'storage_key'
}
export type PublicColumn<T extends Table> = Exclude<ColumnOf<T>, T extends keyof SecretColumns ? SecretColumns[T] : never>

export type ColumnKind = 'uuid' | 'text' | 'timestamp' | 'json' | 'boolean' | 'string_array' | 'integer'
/** Every table exists physically on both engines (CORE40 migrated the last type-only table, api_keys). */
export type PhysicalTable = Table

/**
 * Per column: how the value is bound, cast, read and rendered into record JSON. Doubles as the column
 * inventory the schema-parity tests compare to the physical tables; `satisfies` makes a missing or extra
 * column a compile error.
 */
export const COLUMN_KINDS = {
  organizations: { id: 'uuid', name: 'text', auth_provider: 'text', auth_org_id: 'text', created_at: 'timestamp', updated_at: 'timestamp' },
  principals: { id: 'uuid', kind: 'text', created_at: 'timestamp' },
  events: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    type: 'text',
    resource_type: 'text',
    resource_id: 'uuid',
    actor_id: 'uuid',
    before: 'json',
    after: 'json',
  },
  tasks: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    title: 'text',
    notes: 'text',
    status: 'text',
    due_at: 'timestamp',
    completed_at: 'timestamp',
    assignee_id: 'uuid',
    created_by: 'uuid',
    deleted_at: 'timestamp',
  },
  companies: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    deleted_at: 'timestamp',
    name: 'text',
    domain: 'text',
  },
  contacts: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    deleted_at: 'timestamp',
    name: 'text',
    company_id: 'uuid',
    merged_into_id: 'uuid',
  },
  identities: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    deleted_at: 'timestamp',
    kind: 'text',
    value: 'text',
    contact_id: 'uuid',
    own: 'boolean',
  },
  users: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    email: 'text',
    name: 'text',
    auth_provider: 'text',
    auth_subject: 'text',
    email_verified: 'boolean',
  },
  memberships: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    user_id: 'uuid',
    role: 'text',
    created_by: 'uuid',
    deleted_at: 'timestamp',
  },
  agents: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    name: 'text',
    scopes: 'string_array',
    disabled_at: 'timestamp',
    created_by: 'uuid',
  },
  api_keys: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    agent_id: 'uuid',
    key_hash: 'text',
    prefix: 'text',
    last_used_at: 'timestamp',
    revoked_at: 'timestamp',
    expires_at: 'timestamp',
    created_by: 'uuid',
  },
  threads: { id: 'uuid', created_at: 'timestamp', organization_id: 'uuid', created_by: 'uuid', channel: 'text', subject: 'text' },
  messages: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    thread_id: 'uuid',
    channel: 'text',
    kind: 'text',
    external_id: 'text',
    in_reply_to: 'text',
    author: 'json',
    occurred_at: 'timestamp',
    preview: 'text',
    content_key: 'text',
    version: 'integer',
    retracted_at: 'timestamp',
  },
  interactions: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    kind: 'text',
    channel: 'text',
    direction: 'text',
    occurred_at: 'timestamp',
    thread_id: 'uuid',
    message_id: 'uuid',
  },
  files: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    name: 'text',
    mime_type: 'text',
    size_bytes: 'integer',
    sha256: 'text',
    storage_key: 'text',
  },
  contact_files: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    deleted_at: 'timestamp',
    contact_id: 'uuid',
    file_id: 'uuid',
  },
  company_files: {
    id: 'uuid',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    deleted_at: 'timestamp',
    company_id: 'uuid',
    file_id: 'uuid',
  },
  interaction_participants: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    interaction_id: 'uuid',
    identity_id: 'uuid',
    role: 'text',
  },
  message_attachments: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    message_id: 'uuid',
    position: 'integer',
    file_id: 'uuid',
    type: 'text',
    name: 'text',
    mime_type: 'text',
    size_bytes: 'integer',
    inline: 'boolean',
    content_id: 'text',
    fetch_status: 'text',
    fetch_metadata: 'json',
    fetch_error: 'text',
  },
  message_sources: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    message_id: 'uuid',
    connection_id: 'uuid',
    provider_message_id: 'text',
    provider_thread_id: 'text',
  },
  thread_sources: {
    id: 'uuid',
    created_at: 'timestamp',
    organization_id: 'uuid',
    created_by: 'uuid',
    thread_id: 'uuid',
    connection_id: 'uuid',
    provider_thread_id: 'text',
  },
} as const satisfies { [T in PhysicalTable]: { [C in ColumnOf<T>]: ColumnKind } }
