import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { withUser } from './database-url.js'

const here = dirname(fileURLToPath(import.meta.url))
// `.env.test.local` (gitignored, written by `pnpm db:test:worktree`): a value
// already set in the environment wins.
try {
  const raw = await readFile(resolve(here, '..', '.env.test.local'), 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!
  }
} catch {
  // Fine: env may be supplied by the shell.
}

process.env.TEST_DATABASE_URL ||= 'postgresql://localhost/vault_test'
process.env.TEST_APP_DATABASE_URL ||= withUser(process.env.TEST_DATABASE_URL, 'vault_app')
