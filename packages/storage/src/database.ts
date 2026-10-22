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

export interface OrganizationsTable {
  id: string
  name: string
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
/**
 * TYPE ONLY until [[CORE36]] migrates api_keys (no physical D1 table yet): it exists so the secret-column
 * negative type tests run against a real secret (`key_hash`).
 */
export interface ApiKeysTable {
  id: string
  organization_id: string
  agent_id: string
  key_hash: string
  prefix: string
  created_at: Timestamp
}

export interface StorageDatabase {
  organizations: OrganizationsTable
  principals: PrincipalsTable
  events: EventsTable
  tasks: TasksTable
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
/** Tables that exist physically on both engines in this cycle (api_keys is type-only). */
export type PhysicalTable = Exclude<Table, 'api_keys'>

/**
 * Per column: how the value is bound, cast, read and rendered into record JSON. Doubles as the column
 * inventory the schema-parity tests compare to the physical tables; `satisfies` makes a missing or extra
 * column a compile error.
 */
export const COLUMN_KINDS = {
  organizations: { id: 'uuid', name: 'text', created_at: 'timestamp', updated_at: 'timestamp' },
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
} as const satisfies { [T in PhysicalTable]: { [C in ColumnOf<T>]: ColumnKind } }
