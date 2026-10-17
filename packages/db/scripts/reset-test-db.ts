/**
 * Drops and recreates the test database, then applies all migrations. Tests truncate between
 * cases via `truncateAll()`.
 *
 *   pnpm db:test:reset                       # TEST_DATABASE_URL, .env.test.local or vault_test
 */
import pg from 'pg'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { assertTestDatabaseName } from '../src/database-url.js'
import { createMigrator } from '../src/migrator.js'

// A worktree set up by `pnpm db:test:worktree` has its private DB in `.env.test.local`; honour it,
// so a bare reset there never hits the shared vault_test.
function localTestUrl(): string | undefined {
  try {
    const raw = readFileSync(path.join(import.meta.dirname, '..', '.env.test.local'), 'utf-8')
    return raw.match(/^\s*TEST_DATABASE_URL\s*=\s*(\S+)/m)?.[1]
  } catch {
    return undefined
  }
}

const testUrl = process.env.TEST_DATABASE_URL ?? localTestUrl() ?? 'postgresql://localhost/vault_test'
let targetDb: string
try {
  targetDb = assertTestDatabaseName(testUrl)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

const adminUrl = new URL(testUrl)
adminUrl.pathname = '/postgres'

const admin = new pg.Client({ connectionString: adminUrl.toString() })
await admin.connect()
try {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [targetDb],
  )
  await admin.query(`DROP DATABASE IF EXISTS "${targetDb}"`)
  await admin.query(`CREATE DATABASE "${targetDb}"`)
  console.log(`↻ recreated database "${targetDb}"`)
} finally {
  await admin.end()
}

const { db, migrator } = createMigrator(testUrl)
try {
  const { results, error } = await migrator.migrateToLatest()
  results?.forEach((it) => {
    if (it.status === 'Success') console.log(`↑ ${it.migrationName} applied`)
    else if (it.status === 'Error') console.error(`↑ ${it.migrationName} FAILED`)
  })
  if (error) throw error
} finally {
  await db.destroy()
}
console.log(`✓ test database ready: ${targetDb}`)
