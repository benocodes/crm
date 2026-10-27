// Test-only. The Postgres storage binding for suites that build the app over a `vault_app` pool.
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { postgresBinding } from '@vault/storage-postgres'
import { defineOperation, unit, type PreparedOperation, type StorageBinding } from '@vault/storage'

/** `createApp({ storage: pgStorage(db) })`: one binding for the pool, as composition code would make it. */
export function pgStorage(db: Kysely<Database>): () => StorageBinding {
  const binding = postgresBinding(db)
  return () => binding
}

/** A read-only prepared unit with no statements that returns `value`: the probe tenant operations of the routing and auth suites return it. */
export function probeUnit<T>(value: T, name = 'probe.run'): PreparedOperation<T> {
  return defineOperation<T>({ name, mutates: false, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => value }) })
}

/**
 * A binding whose `execute` throws: for suites that only read `/openapi.json` or CORS headers, or that stop at a 401 before
 * any unit runs. A unit reaching it is a test defect, and the message says so.
 */
export function coldStorage(): () => StorageBinding {
  const binding: StorageBinding = {
    kind: 'postgres',
    runtime: {
      dialect: 'postgres',
      maxSetSize: 0,
      execute: () => Promise.reject(new Error('cold storage: no unit may run')),
    },
  }
  return () => binding
}
