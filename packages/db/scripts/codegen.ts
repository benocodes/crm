/**
 * Regenerates src/types.generated.ts from the catalog of MIGRATION_DATABASE_URL (the owner;
 * `vault_app` has no privileges and could not introspect).
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const bin = resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'kysely-codegen')
const url = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://localhost/vault_dev'

execFileSync(bin, ['--url', url, '--out-file', 'src/types.generated.ts', '--dialect', 'postgres'], {
  stdio: 'inherit',
  cwd: resolve(import.meta.dirname, '..'),
})
