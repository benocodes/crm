// The flags of `vibase-server setup` ([[OPS232]] P1): `setup:remote`'s, with `--secrets-file` and `--settings` in place of `--clerk-env-file`.
// Every refusal is a `RemoteRefusal` (exit 2) raised before any step.
import { RemoteRefusal } from '../remote.js'
import { buildSetupOptions, checkNameLengths, envNameProblem, parseSetupFlags } from '../setup/args.js'
import type { RecordedAuth } from '../setup/better-auth.js'
import { recordedMode } from '../setup/host.js'
import type { SetupOptions } from '../setup/types.js'
import type { InitSettings } from './types.js'

export interface InstanceSetupArgs {
  opts: SetupOptions
  settingsPath?: string
  secretsPath?: string
  /** [[OPS493]] D3: `--yes` / `-y`. */
  yes: boolean
}

/**
 * What the settings file says about an instance, found by its env and the `--settings` path as given; `null` when there is no settings file. A set-up instance's record
 * ([[OPS249]] D1) carries its provider, host and (once recorded) owner email; the file `init` wrote ([[OPS501]]) carries the three choices setup would otherwise need as flags.
 */
export type InstanceFile =
  | { kind: 'full'; record: RecordedAuth; ownerEmail?: string }
  | { kind: 'init'; init: InitSettings; where: string }
export type InstanceRecordLookup = (env: string, settingsPath: string | undefined) => InstanceFile | null

type Flags = Record<string, unknown>

/** [[OPS501]] D3: the init file's value is the default of its flag; a flag that differs is refused naming the flag, the value and the file. */
function applyInitFile(values: Flags, init: InitSettings, where: string): void {
  const differs = (flag: string, key: string, recorded: string) =>
    new RemoteRefusal(
      `${flag}: ${where} (written by init) records ${key} ${recorded}: edit ${key} in ${where} or drop the flag`,
    )
  if (values['change-host'] === true)
    throw new RemoteRefusal(
      `--change-host: ${where} was written by init, so nothing is deployed to move: edit api_host in it`,
    )
  const host = values['api-host'] as string | undefined
  if (host !== undefined && host !== init.api_host) throw differs(`--api-host ${host}`, 'api_host', init.api_host)
  if (values['workers-dev'] === true) throw differs('--workers-dev', 'api_host', init.api_host)
  values['api-host'] = init.api_host
  const auth = values.auth as string | undefined
  if (auth !== undefined && auth !== init.auth) throw differs(`--auth ${auth}`, 'auth', init.auth)
  values.auth = init.auth
  const email = values['owner-email'] as string | undefined
  if (init.owner_email !== undefined) {
    if (email !== undefined && email !== init.owner_email)
      throw differs(`--owner-email ${email}`, 'owner_email', init.owner_email)
    values['owner-email'] = init.owner_email
  }
}

/** [[OPS501]] D4, D6: a recorded instance's host is the default of the host flags, and its owner email (when one was recorded) the default of `--owner-email`. */
function applyRecord(values: Flags, file: Extract<InstanceFile, { kind: 'full' }>): void {
  const host = file.record.host
  if (host !== undefined && values['api-host'] === undefined && values['workers-dev'] !== true) {
    if (recordedMode(host) === 'workers-dev') values['workers-dev'] = true
    else values['api-host'] = host.apiHost
  }
  const recorded = file.ownerEmail
  if (recorded === undefined) return
  const email = values['owner-email'] as string | undefined
  if (email !== undefined && email !== recorded)
    throw new RemoteRefusal(
      `--owner-email ${email}: ${file.record.where} records owner_email ${recorded}, which setup does not change: use vibase-server owner-reset --env ${values.env as string} --email ${email} for a new address`,
    )
  values['owner-email'] = recorded
}

export function parseInstanceSetupArgs(argv: string[], record?: InstanceRecordLookup): InstanceSetupArgs {
  const values = parseSetupFlags(argv, {
    settings: { type: 'string' },
    'secrets-file': { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
  })
  const env = values.env as string | undefined
  // The env is judged before it names a path.
  const file = record && env && envNameProblem(env) === null ? record(env, values.settings as string | undefined) : null
  if (file?.kind === 'init') applyInitFile(values, file.init, file.where)
  if (file?.kind === 'full') applyRecord(values, file)
  // An init-written file is no record: the run is a new instance's, with the defaults above.
  const opts = buildSetupOptions(values, file?.kind === 'full' ? () => file.record : undefined)
  // The Workflow's derived name is the longest of the four ([[OPS262]] D5); the settings file records it, so the check lives here.
  checkNameLengths([`vb-mail-sync-${opts.env}`])
  return {
    opts,
    settingsPath: values.settings as string | undefined,
    secretsPath: values['secrets-file'] as string | undefined,
    yes: values.yes === true,
  }
}
