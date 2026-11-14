// Read-only migration status of a deployed instance ([[CORE61]] D7):
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:status:remote -- --env <name>
// Same guards as `db:migrate:remote`; reads wrangler's `d1_migrations` and prints the applied-versus-expected diff.
// Exit code 0 only when the database is `current`.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import { CONTROL_MIGRATIONS, MIGRATIONS } from '@vibase/storage-d1'
import { CONFIG_PATH, PACKAGE_DIR, controlNotConfigured, RemoteRefusal, formatMigrationDiff, loadRootEnv, parseEnvFlag, parseTrackerOutput, requireConfirm, resolveTarget, statusExitCode, statusOf, trackerReadCommand, type Cmd, type ConfigLike, type Target } from './remote.js'

export const EXPECTED = MIGRATIONS.map((m) => m.name)
/** The control plane's shipped set ([[CORE259]] D4): "current" is applied equals this, exactly. */
export const CONTROL_EXPECTED = CONTROL_MIGRATIONS.map((m) => m.name)

export interface StatusDeps {
  loadEnv(): void
  readConfig(envName: string): ConfigLike
  exec(cmd: Cmd): { status: number | null; stdout: string }
  log(line: string): void
}

export const realDeps: StatusDeps = {
  loadEnv: () => loadRootEnv(),
  readConfig: (envName) => unstable_readConfig({ config: CONFIG_PATH, env: envName }) as unknown as ConfigLike,
  exec: (cmd) => {
    const r = spawnSync(cmd.command, cmd.args, { cwd: PACKAGE_DIR, encoding: 'utf-8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
    return { status: r.status, stdout: r.stdout ?? '' }
  },
  log: (line) => console.log(line),
}

/** The guards every remote script runs first ([[OPS4]] C3, C4): the env flag, the confirmation, credentials, the target. */
export function guardedTarget(argv: string[], procEnv: NodeJS.ProcessEnv, deps: Pick<StatusDeps, 'loadEnv' | 'readConfig'>): Target {
  const envName = parseEnvFlag(argv)
  requireConfirm(procEnv)
  deps.loadEnv()
  return resolveTarget(deps.readConfig(envName), envName)
}

/** Reads the applied names (`null`: no tracker). A failed read throws. */
export function readApplied(envName: string, deps: Pick<StatusDeps, 'exec'>, binding: 'DB' | 'CONTROL_DB' = 'DB'): string[] | null {
  const r = deps.exec(trackerReadCommand(envName, binding))
  return parseTrackerOutput(r.stdout)
}

/**
 * Prints each database's diff and returns the exit code ([[OPS260]] D14): the control database first when the env has one, then the CRM database. Exit 0 only when every configured
 * database is current; each line names its database. An env with no `CONTROL_DB` entry is reported CRM only, with one line saying so (P1).
 */
export function runStatus(argv: string[], procEnv: NodeJS.ProcessEnv, deps: StatusDeps): number {
  const target = guardedTarget(argv, procEnv, deps)
  let code = 0
  if (target.control) {
    deps.log(`target: env ${target.env}, control database ${target.control.databaseName} (${target.control.databaseId})`)
    const applied = readApplied(target.env, deps, 'CONTROL_DB')
    for (const line of formatMigrationDiff(applied, CONTROL_EXPECTED)) deps.log(`[control] ${line}`)
    code = Math.max(code, statusExitCode(statusOf(applied, CONTROL_EXPECTED)))
  } else deps.log(controlNotConfigured(target.env))
  deps.log(`target: env ${target.env}, database ${target.databaseName} (${target.databaseId})`)
  const applied = readApplied(target.env, deps)
  for (const line of formatMigrationDiff(applied, EXPECTED)) deps.log(`[crm] ${line}`)
  return Math.max(code, statusExitCode(statusOf(applied, EXPECTED)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = runStatus(process.argv.slice(2), process.env, realDeps)
  } catch (err) {
    if (err instanceof RemoteRefusal) console.error(`status-remote: ${err.message}`)
    else console.error(`status-remote: ${err instanceof Error ? err.message : 'failed'}`)
    process.exitCode = 1
  }
}
