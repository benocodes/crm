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
}

export type Table = keyof StorageDatabase & string
export type RowOf<T extends Table> = Selectable<StorageDatabase[T]>
export type ColumnOf<T extends Table> = keyof RowOf<T> & string
/** The value a column accepts in a predicate or an update. */
export type ValueOf<T extends Table, C extends ColumnOf<T>> = UpdateType<StorageDatabase[T][C & keyof StorageDatabase[T]]>

/** Columns that must never appear in a public projection, per table. */
export interface SecretColumns {
  api_keys: 'key_hash'
}
export type PublicColumn<T extends Table> = Exclude<ColumnOf<T>, T extends keyof SecretColumns ? SecretColumns[T] : never>

export type ColumnKind = 'uuid' | 'text' | 'timestamp' | 'json' | 'boolean' | 'string_array'
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
} as const satisfies { [T in PhysicalTable]: { [C in ColumnOf<T>]: ColumnKind } }
