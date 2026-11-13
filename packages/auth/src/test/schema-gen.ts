// The offline DDL generator ([[CORE243]] D4): Better Auth's own schema planner run against an EMPTY local SQLite (its planner cannot introspect D1, `SQLITE_AUTH`),
// so what it prints is every auth table the composed plugins need, in the vault's names. Test and script support only: it imports `node:sqlite`, which no Worker bundle may.
import { DatabaseSync } from 'node:sqlite'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from '../auth.js'

export async function generateAuthDdl(): Promise<string> {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const options = authOptions({ prepare: () => undefined }, { secret: 'x'.repeat(40), baseURL: 'https://vibase.example' })
    const plan = await getMigrations({ ...options, database: sqlite } as never)
    return await plan.compileMigrations()
  } finally {
    sqlite.close()
  }
}
