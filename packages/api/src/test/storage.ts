// Test-only. The Postgres storage binding for suites that build the app over a `vault_app` pool.
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { postgresBinding } from '@vault/storage-postgres'
import type { StorageBinding } from '@vault/storage'

/** `createApp({ db: () => db, storage: pgStorage(db) })`: one binding for the pool, as composition code would make it. */
export function pgStorage(db: Kysely<Database>): () => StorageBinding {
  const binding = postgresBinding(db)
  return () => binding
}
