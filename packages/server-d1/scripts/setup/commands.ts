// The subprocesses `setup:remote` issues and their parsers ([[OPS65]] D6): every wrangler and git call the steps make is built here,
// so the set of writes is one list (`isWriteCommand`) the dry-run guard checks.
import { deployCommands, migrateCommands, parseTrackerOutput, trackerReadCommand, type Cmd } from '../remote.js'
import type { SetupCmd } from './types.js'

const wrangler = (args: string[]): SetupCmd => ({ command: 'pnpm', args: ['exec', 'wrangler', ...args], cwd: 'package' })

export const d1ListCommand = (): SetupCmd => wrangler(['d1', 'list', '--json'])
export const d1CreateCommand = (name: string): SetupCmd => wrangler(['d1', 'create', name])
export const r2ListCommand = (): SetupCmd => wrangler(['r2', 'bucket', 'list'])
export const r2CreateCommand = (name: string): SetupCmd => wrangler(['r2', 'bucket', 'create', name])
export const trackerCommand = (env: string): SetupCmd => ({ ...trackerReadCommand(env), cwd: 'package' })
export const migrateStepCommands = (env: string): SetupCmd[] => migrateCommands(env).map((c) => ({ ...c, cwd: 'package' as const, inherit: true }))
export const gitHead = (): SetupCmd => ({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: 'root' })
export const gitStatus = (): SetupCmd => ({ command: 'git', args: ['status', '--porcelain'], cwd: 'root' })
/** `deploy:remote`'s own commands (typecheck, the suite, `wrangler deploy --var VERSION:<sha>`), with its working directories ([[OPS4]] D12). */
export const deployStepCommands = (env: string, sha: string): SetupCmd[] =>
  deployCommands(env, sha).map((c: Cmd) => ({ ...c, cwd: c.args.includes('deploy') ? ('package' as const) : ('root' as const), inherit: true }))
/** The marker row and whether an organisation exists (D39), in one read. */
export const markerCommand = (env: string): SetupCmd =>
  wrangler(['d1', 'execute', 'DB', '--remote', '--env', env, '--json', '--command', 'select organization_id, auth_provider, auth_org_id, (select count(*) from organizations) as organizations from deployment where singleton = 1'])
/** `wrangler secret list --format json`: `[{name, type}]`, the names only are read. */
export const secretListCommand = (env: string): SetupCmd => wrangler(['secret', 'list', '--env', env, '--format', 'json'])
/** `wrangler secret bulk --env <name>`: the JSON object `{NAME: value}` goes on stdin, never argv (D12). */
export const secretBulkCommand = (env: string, json: string): SetupCmd => ({ ...wrangler(['secret', 'bulk', '--env', env]), input: json })

/** Commands that create, apply or deploy: never issued in a dry run. */
export function isWriteCommand(cmd: SetupCmd): boolean {
  if (cmd.command !== 'pnpm') return false
  const a = cmd.args.join(' ')
  return /\bwrangler d1 create\b/.test(a) || /\bwrangler r2 bucket create\b/.test(a) || /\bwrangler d1 migrations apply\b/.test(a) || /\bwrangler deploy\b/.test(a) || /\bwrangler secret bulk\b/.test(a)
}

/** `wrangler d1 list --json`: `[ { uuid, name, ... } ]`. */
export function parseD1List(stdout: string): { uuid: string; name: string }[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('unreadable output from wrangler d1 list')
  }
  if (!Array.isArray(json)) throw new Error('unexpected output shape from wrangler d1 list')
  return json.map((d) => {
    const { uuid, name } = (d ?? {}) as { uuid?: unknown; name?: unknown }
    if (typeof uuid !== 'string' || typeof name !== 'string') throw new Error('unexpected row shape from wrangler d1 list')
    return { uuid, name }
  })
}

/** `wrangler r2 bucket list` has no JSON mode: one `name:  <bucket>` line per bucket. */
export function parseR2List(stdout: string): string[] {
  return [...stdout.matchAll(/^name:\s+(\S+)\s*$/gm)].map((m) => m[1]!)
}

export interface MarkerRow {
  organizationId: string
  authProvider: string
  authOrgId: string
  /** How many organisations exist (0 when the read did not say). */
  organizations: number
}
/** The marker read: `null` row when the table is empty, `'no-table'` when the database is not migrated; other errors throw. */
export function parseMarkerOutput(stdout: string): MarkerRow | null | 'no-table' {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('unreadable output from wrangler d1 execute')
  }
  const error = (json as { error?: { text?: unknown } } | null)?.error
  if (error) {
    const text = typeof error.text === 'string' ? error.text : ''
    if (/no such table/i.test(text)) return 'no-table'
    throw new Error(`wrangler d1 execute failed: ${text || 'unknown error'}`)
  }
  const results = Array.isArray(json) ? (json[0] as { results?: unknown } | undefined)?.results : undefined
  if (!Array.isArray(results)) throw new Error('unexpected output shape from wrangler d1 execute')
  const row = results[0] as Record<string, unknown> | undefined
  if (!row) return null
  const { organization_id: organizationId, auth_provider: authProvider, auth_org_id: authOrgId } = row
  if (typeof organizationId !== 'string' || typeof authProvider !== 'string' || typeof authOrgId !== 'string') throw new Error('unexpected marker row shape')
  return { organizationId, authProvider, authOrgId, organizations: typeof row.organizations === 'number' ? row.organizations : 0 }
}

/** The secret names of `wrangler secret list --format json`. */
export function parseSecretList(stdout: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('unreadable output from wrangler secret list')
  }
  if (!Array.isArray(json)) throw new Error('unexpected output shape from wrangler secret list')
  return json.map((s) => (s as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === 'string')
}

export { parseTrackerOutput }
