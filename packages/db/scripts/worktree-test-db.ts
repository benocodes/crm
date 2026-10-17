/**
 * Gives the current git worktree its own test database, so its suites never share vault_test with
 * another session. Names the DB after the worktree folder (`.claude/worktrees/core1` →
 * `vault_test_core1`), writes a gitignored `packages/db/.env.test.local`, then drops, recreates and
 * migrates it via `reset-test-db.ts`. Rerun it to reset the DB.
 *
 *   pnpm db:test:worktree           # create / reset
 *   pnpm db:test:worktree --drop    # drop the DB and remove .env.test.local
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import pg from 'pg'
import { worktreeDatabaseName } from '../src/database-url.js'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
// A linked worktree's `.git` is a file; the main checkout's is a directory.
if (statSync(path.join(root, '.git')).isDirectory()) {
  console.error('refusing: this is the main checkout, which uses the shared vault_test. Run this inside a worktree.')
  process.exit(1)
}

const dbName = worktreeDatabaseName(root)
const envFile = path.join(root, 'packages/db/.env.test.local')

if (process.argv.includes('--drop')) {
  const admin = new pg.Client({ connectionString: `postgresql://localhost/postgres` })
  await admin.connect()
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    )
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`)
  } finally {
    await admin.end()
  }
  if (existsSync(envFile)) rmSync(envFile)
  console.log(`✗ dropped "${dbName}" and removed .env.test.local`)
  process.exit(0)
}

const ownerUrl = `postgresql://localhost/${dbName}`
writeFileSync(
  envFile,
  `TEST_DATABASE_URL=${ownerUrl}\nTEST_APP_DATABASE_URL=postgresql://vault_app@localhost/${dbName}\n`,
)
console.log(`→ wrote packages/db/.env.test.local → ${dbName}`)

const reset = spawnSync('tsx', [path.join(import.meta.dirname, 'reset-test-db.ts')], {
  stdio: 'inherit',
  env: { ...process.env, TEST_DATABASE_URL: ownerUrl },
})
process.exit(reset.status ?? 1)
