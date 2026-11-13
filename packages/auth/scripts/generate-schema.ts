import { DatabaseSync } from 'node:sqlite'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from '/Users/ori/Code/crm/.claude/worktrees/core243/packages/auth/src/auth.js'
const sqlite = new DatabaseSync(':memory:')
const o = { AUTH_PROVIDER: 'better-auth' as const, AUTH_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'http://localhost:8787', DB: {} as any }
const plan = await getMigrations({ ...authOptions(o), database: sqlite } as any)
console.log(await plan.compileMigrations())
