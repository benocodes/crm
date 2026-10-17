import { Kysely, PostgresDialect } from 'kysely'
import { FileMigrationProvider, Migrator } from 'kysely/migration'
import pg from 'pg'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Database } from './types.js'

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** A Migrator bound to `connectionString` (connect as the database owner). The caller `destroy()`s `db`. */
export function createMigrator(connectionString: string): { db: Kysely<Database>; migrator: Migrator } {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  })
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsDir }),
  })
  return { db, migrator }
}
