// Shared guards of the remote scripts ([[OPS4]] C3, C4): every command that can reach a deployed instance goes through
// these, before any network call or query. Pure parts are exported and unit-tested; nothing here logs an environment value.
import { fileURLToPath } from 'node:url'

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
