// Applies the D1 migrations to a deployed instance ([[OPS4]] C5, D7; [[OPS260]] D14):
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env <name>
// Guards first (env flag, confirmation, credentials, target), then per database the migration diff, `migrations list`, `migrations apply` and the diff again ([[CORE61]] D7), remote.
// The control-plane database (`CONTROL_DB`) is migrated FIRST and a failure there stops before the CRM step; an env whose config has no `CONTROL_DB` entry is migrated CRM only and says so (P1).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CONTROL_EXPECTED, EXPECTED, guardedTarget, readApplied, realDeps, type StatusDeps } from './status-remote.js'
import { PACKAGE_DIR, RemoteRefusal, controlNotConfigured, formatMigrationDiff, migrateCommands } from './remote.js'

export type MigrateDeps = StatusDeps

/** Runs the guarded migration and returns the exit code (non-zero when a wrangler step failed: the later steps never run). */
export function runMigrate(argv: string[], procEnv: NodeJS.ProcessEnv, deps: MigrateDeps): number {
  const target = guardedTarget(argv, procEnv, deps)
  const databases = [
    ...(target.control ? [{ label: 'control', binding: 'CONTROL_DB' as const, expected: CONTROL_EXPECTED, name: target.control.databaseName, id: target.control.databaseId }] : []),
    { label: 'crm', binding: 'DB' as const, expected: EXPECTED, name: target.databaseName, id: target.databaseId },
  ]
  if (!target.control) deps.log(controlNotConfigured(target.env))
  const commands = migrateCommands(target.env, { control: Boolean(target.control) })
  for (const db of databases) {
    deps.log(`target: env ${target.env}, ${db.label} database ${db.name} (${db.id})`)
    const show = (when: string) => {
      try {
        deps.log(`[${db.label}] ${when}:`)
        for (const line of formatMigrationDiff(readApplied(target.env, deps, db.binding), db.expected)) deps.log(`  ${line}`)
      } catch (err) {
        deps.log(`  migrations: could not be read (${err instanceof Error ? err.message : 'failed'})`)
      }
    }
    show('before')
    for (const cmd of commands.filter((c) => c.args[5] === db.binding)) {
      const r = deps.exec(cmd)
      if (r.stdout) deps.log(r.stdout.trimEnd())
      if (r.status !== 0) {
        deps.log(`[${db.label}] ${cmd.args[4]} failed (exit ${r.status ?? 'none'}): later steps did not run`)
        return r.status ?? 1
      }
    }
    show('after')
  }
  return 0
}

// stdout is captured (the tracker reads are parsed as JSON); wrangler's own stderr goes straight to the terminal.
const realExec: MigrateDeps['exec'] = (cmd) => {
  const r = spawnSync(cmd.command, cmd.args, { cwd: PACKAGE_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
  return { status: r.status, stdout: r.stdout ?? '' }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = runMigrate(process.argv.slice(2), process.env, { ...realDeps, exec: realExec })
  } catch (err) {
    if (!(err instanceof RemoteRefusal)) throw err
    console.error(`migrate-remote: ${err.message}`)
    process.exitCode = 1
  }
}
