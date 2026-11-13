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

/** The control marker's DDL ([[CORE259]] D7): appended to the generated Better Auth DDL in control migration 0001. */
export const CONTROL_DEPLOYMENT_DDL = `create table control_deployment (
  singleton integer primary key not null check (singleton = 1),
  organization_id text not null
    check (length(organization_id) = 36 and organization_id not glob '*[^0-9a-f-]*' and substr(organization_id, 9, 1) = '-' and substr(organization_id, 14, 1) = '-' and substr(organization_id, 19, 1) = '-' and substr(organization_id, 24, 1) = '-')
) strict;
`
