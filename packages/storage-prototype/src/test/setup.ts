import '@vault/db/test-setup'
import { execFileSync } from 'node:child_process'
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
if (!root.endsWith('/core33')) throw new Error('requires core33 worktree')
for (const key of ['TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL']) {
  const value = process.env[key]
  if (!value || new URL(value).pathname !== '/vault_test_core33')
    throw new Error(`${key}: requires vault_test_core33`)
}
