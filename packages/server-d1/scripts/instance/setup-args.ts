// The flags of `vibase-server setup` ([[OPS232]] P1): `setup:remote`'s, with `--secrets-file` and `--settings` in place of `--clerk-env-file`.
// Every refusal is a `RemoteRefusal` (exit 2) raised before any step.
import { buildSetupOptions, checkNameLengths, parseSetupFlags } from '../setup/args.js'
import type { RecordedAuth } from '../setup/better-auth.js'
import type { SetupOptions } from '../setup/types.js'

export interface InstanceSetupArgs {
  opts: SetupOptions
  settingsPath?: string
  secretsPath?: string
}

/** Finds an instance's recorded provider from its settings file ([[OPS249]] D1): the env and the `--settings` path as given; `null` when there is no settings file. */
export type InstanceRecordLookup = (env: string, settingsPath: string | undefined) => RecordedAuth | null

export function parseInstanceSetupArgs(argv: string[], record?: InstanceRecordLookup): InstanceSetupArgs {
  const values = parseSetupFlags(argv, { settings: { type: 'string' }, 'secrets-file': { type: 'string' } })
  const opts = buildSetupOptions(values, record ? (env) => record(env, values.settings as string | undefined) : undefined)
  // The Workflow's derived name is the longest of the four ([[OPS262]] D5); the settings file records it, so the check lives here.
  checkNameLengths([`vb-mail-sync-${opts.env}`])
  return { opts, settingsPath: values.settings as string | undefined, secretsPath: values['secrets-file'] as string | undefined }
}
