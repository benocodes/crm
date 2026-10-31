// Applies the D1 migrations to a deployed instance ([[OPS4]] C5, D7):
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env <name>
// Guards first (env flag, confirmation, credentials, target), then the migration diff, `migrations list`, `migrations apply`
// and the diff again ([[CORE61]] D7), remote.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import { EXPECTED, readApplied, realDeps } from './status-remote.js'
import { CONFIG_PATH, formatMigrationDiff, PACKAGE_DIR, RemoteRefusal, loadRootEnv, migrateCommands, parseEnvFlag, requireConfirm, resolveTarget, type ConfigLike } from './remote.js'

function main(): void {
  const envName = parseEnvFlag(process.argv.slice(2))
  requireConfirm(process.env)
  loadRootEnv()
  const target = resolveTarget(unstable_readConfig({ config: CONFIG_PATH, env: envName }) as unknown as ConfigLike, envName)
  console.log(`target: env ${target.env}, database ${target.databaseName} (${target.databaseId})`)
  const show = (label: string) => {
    try {
      console.log(`${label}:`)
      for (const line of formatMigrationDiff(readApplied(envName, realDeps), EXPECTED)) console.log(`  ${line}`)
    } catch (err) {
      console.log(`  migrations: could not be read (${err instanceof Error ? err.message : 'failed'})`)
    }
  }
  show('before')
  for (const { command, args } of migrateCommands(envName)) {
    const r = spawnSync(command, args, { cwd: PACKAGE_DIR, stdio: 'inherit', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
    if (r.status !== 0) {
      process.exitCode = r.status ?? 1
      return
    }
  }
  show('after')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (err) {
    if (!(err instanceof RemoteRefusal)) throw err
    console.error(`migrate-remote: ${err.message}`)
    process.exitCode = 1
  }
}
