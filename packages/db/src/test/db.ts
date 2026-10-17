import { sql, type Kysely } from 'kysely'
import { createDb } from '../db.js'
import type { Database } from '../types.js'

/**
 * A pool connecting as `vault_app`: no table privileges, no preset role or `app.*` settings, so a
 * query outside a tenancy wrapper fails exactly as in production (AGENTS.md invariant 2). Do not add
 * an `on('connect')` hook here.
 */
export function createTestDb(options?: { max?: number }): Kysely<Database> {
  const url = process.env.TEST_APP_DATABASE_URL
  if (!url) throw new Error('TEST_APP_DATABASE_URL is not set (run `pnpm db:test:worktree`)')
  return createDb(url, options)
}

/** The database owner, for truncation and catalog inspection only. Never for fixtures. */
export function createOwnerTestDb(): Kysely<Database> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not set (run `pnpm db:test:worktree`)')
  return createDb(url, { max: 2 })
}

export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || i >= attempts) throw err
      await new Promise((r) => setTimeout(r, 25 * i))
    }
  }
}

/** Truncates every base table in `public` except Kysely's own, listed from the catalog now. */
export async function truncateAll(ownerDb: Kysely<Database>): Promise<void> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('kysely_migration', 'kysely_migration_lock')`.execute(ownerDb)
  if (rows.length === 0) return
  await retryOnDeadlock(async () => {
    await sql`TRUNCATE ${sql.join(rows.map((r) => sql.table(r.table_name)))} RESTART IDENTITY CASCADE`.execute(ownerDb)
  })
}
