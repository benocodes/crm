// `vibase-server status --env <name>` ([[OPS210]] D15, [[OPS231]]): the gate's reads and the upgrade plan. Read-only: it writes nothing remote,
// needs no CONFIRM_REMOTE and never runs a write command.
import { parseArgs } from 'node:util'
import { formatMigrationDiff, statusOf } from '../remote.js'
import { runGate } from './gate.js'
import { InstanceRefusal, isRefusal, type InstanceDeps } from './types.js'

/** Exit codes: 0 the instance is at this release and `current`; 1 it is not (a plan or a note was printed); 2 refused. */
export const EXIT_CURRENT = 0
export const EXIT_BEHIND = 1
export const EXIT_REFUSED = 2

export async function runStatus(argv: string[], deps: InstanceDeps): Promise<number> {
  try {
    let values: { env?: string; settings?: string; 'secrets-file'?: string }
    try {
      values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { env: { type: 'string' }, settings: { type: 'string' }, 'secrets-file': { type: 'string' } } }).values
    } catch (e) {
      const rollback = argv.includes('--rollback')
      throw new InstanceRefusal(rollback ? 'status does not accept --rollback (it belongs to upgrade)' : `${e instanceof Error ? e.message : 'bad arguments'}; usage: vibase-server status --env <name> [--settings <path>] [--secrets-file <path>]`)
    }
    if (!values.env) throw new InstanceRefusal('--env <name> is required; usage: vibase-server status --env <name> [--settings <path>] [--secrets-file <path>]')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(values.env)) throw new InstanceRefusal(`--env ${values.env} is not an environment name (lowercase letters, digits and dashes)`)
    const g = await runGate({ envName: values.env, settingsPath: values.settings, secretsPath: values['secrets-file'] }, deps)
    const expected = g.manifest.migrations.map((m) => m.name)
    const migrations = statusOf(g.applied, expected)
    deps.out(`package: vibase-server/${g.manifest.version} (${g.manifest.commit}), ${Object.keys(g.manifest.files).length} files verified`)
    deps.out(`instance: ${g.settings.env} at https://${g.settings.api_host} (worker ${g.settings.worker}, settings ${g.settingsPath})`)
    deps.out(`live: version ${g.live.version}${g.live.commit ? `, commit ${g.live.commit}` : ''}`)
    for (const n of g.notes) deps.out(`note: ${n}`)
    for (const l of formatMigrationDiff(g.applied, expected)) deps.out(l)
    const sameVersion = g.live.version === g.manifest.version
    if (sameVersion && migrations === 'current') {
      deps.out(`plan: nothing to do, the instance is at ${g.manifest.version}`)
      return EXIT_CURRENT
    }
    deps.out(`plan: live ${g.live.version} -> package ${g.manifest.version}`)
    deps.out(g.pending.length === 0 ? 'migrations to apply: none' : `migrations to apply (${g.pending.length}):`)
    for (const n of g.pending) deps.out(`  ${n}`)
    return EXIT_BEHIND
  } catch (e) {
    if (!isRefusal(e)) throw e
    deps.err(`vibase-server status: ${e.message}`)
    return EXIT_REFUSED
  }
}
