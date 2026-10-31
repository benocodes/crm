// Shared guards of the remote scripts ([[OPS4]] C3, C4): every command that can reach a deployed instance goes through
// these, before any network call or query. Pure parts are exported and unit-tested; nothing here logs an environment value.
import { fileURLToPath } from 'node:url'
import { compareMigrations, type MigrationStatus } from '@vault/storage-d1'

export const PLACEHOLDER_DATABASE_ID = '00000000-0000-0000-0000-000000000000'

/** A refusal the CLIs print as `<script>: <message>` (exit 1) before any network call or query. */
export class RemoteRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteRefusal'
  }
}

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const ROOT_ENV_PATH = `${REPO_ROOT}.env`
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
export const CONFIG_PATH = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))

export interface D1BindingConfig {
  binding: string
  database_name?: string
  database_id?: string
  remote?: boolean
  preview_database_id?: string
}
/** The part of wrangler's resolved `Config` the guards read. */
export interface ConfigLike {
  name?: string
  d1_databases?: D1BindingConfig[]
}
export interface Target {
  env: string
  workerName: string
  databaseName: string
  databaseId: string
}
export interface Cmd {
  command: 'pnpm'
  args: string[]
}

/** The value of `--env <name>` / `--env=<name>`. */
export function parseEnvFlag(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--env') {
      const v = argv[i + 1]
      if (v) return v
      break
    }
    if (a.startsWith('--env=') && a.length > '--env='.length) return a.slice('--env='.length)
  }
  throw new RemoteRefusal('--env <name> is required')
}

export function requireConfirm(env: NodeJS.ProcessEnv): void {
  if (env.CONFIRM_REMOTE !== '1') throw new RemoteRefusal('set CONFIRM_REMOTE=1 to run against a remote instance')
}

/** Loads the root `.env` (existing process variables win) and requires the Cloudflare credentials. Never logs a value. */
export function loadRootEnv(path: string = ROOT_ENV_PATH): void {
  try {
    process.loadEnvFile(path)
  } catch {
    // no .env: the credentials may come from the process environment
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
    throw new RemoteRefusal('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env')
  }
}

/** The instance a remote script would touch, or a refusal. The top level (`name: vault`) is local-only ([[OPS4]] D3). */
export function resolveTarget(config: ConfigLike, envName: string): Target {
  if (config.name === 'vault') throw new RemoteRefusal(`unknown env ${envName}`)
  const db = config.d1_databases?.find((d) => d.binding === 'DB')
  if (!db) throw new RemoteRefusal(`env ${envName} has no DB binding`)
  if (db.database_id === PLACEHOLDER_DATABASE_ID) {
    throw new RemoteRefusal(`env ${envName} still has the placeholder database_id: create the database and commit its id first`)
  }
  if (db.remote !== true || (db.preview_database_id !== undefined && db.preview_database_id !== db.database_id)) {
    throw new RemoteRefusal(`env ${envName}'s DB binding must be remote: true with no preview_database_id`)
  }
  return { env: envName, workerName: config.name ?? '', databaseName: db.database_name ?? '', databaseId: db.database_id ?? '' }
}

export function migrateCommands(envName: string): Cmd[] {
  return (['list', 'apply'] as const).map((verb) => ({
    command: 'pnpm' as const,
    args: ['exec', 'wrangler', 'd1', 'migrations', verb, 'DB', '--remote', '--env', envName],
  }))
}

export function deployCommands(envName: string, sha: string): Cmd[] {
  return [
    { command: 'pnpm', args: ['-C', 'packages/server-d1', 'typecheck'] },
    { command: 'pnpm', args: ['-C', 'packages/server-d1', 'test'] },
    { command: 'pnpm', args: ['exec', 'wrangler', 'deploy', '--env', envName, '--var', `VERSION:${sha}`] },
  ]
}

/** The read of wrangler's tracker on a deployed instance ([[CORE61]] D7): same `--remote --env` addressing as `migrations apply`. */
export function trackerReadCommand(envName: string): Cmd {
  return { command: 'pnpm', args: ['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--env', envName, '--json', '--command', 'select name from d1_migrations'] }
}

/**
 * The applied names from `wrangler d1 execute --json` output: `[ { results: [ { name } ], success } ]`. `null` when the tracker
 * does not exist (`{ error: { text: "no such table: d1_migrations" } }`); any other error or shape throws.
 */
export function parseTrackerOutput(stdout: string): string[] | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('unreadable output from wrangler d1 execute')
  }
  const error = (json as { error?: { text?: unknown } } | null)?.error
  if (error) {
    const text = typeof error.text === 'string' ? error.text : ''
    if (/no such table/i.test(text)) return null
    throw new Error(`wrangler d1 execute failed: ${text || 'unknown error'}`)
  }
  const results = Array.isArray(json) ? (json[0] as { results?: unknown } | undefined)?.results : undefined
  if (!Array.isArray(results)) throw new Error('unexpected output shape from wrangler d1 execute')
  return results.map((r) => {
    const name = (r as { name?: unknown } | null)?.name
    if (typeof name !== 'string') throw new Error('unexpected row shape from wrangler d1 execute')
    return name
  })
}

/** The status a printed diff reports: a missing tracker is `unknown` (applied `null`). */
export function statusOf(applied: readonly string[] | null, expected: readonly string[]): MigrationStatus {
  return applied === null ? 'unknown' : compareMigrations(applied, expected).status
}

/** The D9 diff as lines for an owner ([[CORE61]] D7); the Worker's `/health` reports the same status. */
export function formatMigrationDiff(applied: readonly string[] | null, expected: readonly string[]): string[] {
  const status = statusOf(applied, expected)
  if (applied === null) return [`migrations: unknown (no d1_migrations table; ${expected.length} expected)`]
  const d = compareMigrations(applied, expected)
  const lines = [`migrations: ${status} (${applied.length} applied, ${expected.length} expected)`]
  for (const n of d.missing) lines.push(`  missing  ${n}`)
  for (const n of d.extra) lines.push(`  extra    ${n}`)
  return lines
}

/** Exit code of `db:status:remote`: 0 only for `current`, so a CI step can gate on it. */
export const statusExitCode = (status: MigrationStatus): number => (status === 'current' ? 0 : 1)
