// The flags of `vibase-server setup` ([[OPS232]] P1): `setup:remote`'s, with `--secrets-file` and `--settings` in place of `--clerk-env-file`.
// Every refusal is a `RemoteRefusal` (exit 2) raised before any step.
import { buildSetupOptions, checkNameLengths, parseSetupFlags } from '../setup/args.js'
import type { SetupOptions } from '../setup/types.js'

export interface InstanceSetupArgs {
  opts: SetupOptions
  settingsPath?: string
  secretsPath?: string
}

export function parseInstanceSetupArgs(argv: string[]): InstanceSetupArgs {
  const values = parseSetupFlags(argv, { settings: { type: 'string' }, 'secrets-file': { type: 'string' } })
  const opts = buildSetupOptions(values)
  // The Workflow's derived name is the longest of the four ([[OPS262]] D5); the settings file records it, so the check lives here.
  checkNameLengths([`vb-mail-sync-${opts.env}`])
  return { opts, settingsPath: values.settings as string | undefined, secretsPath: values['secrets-file'] as string | undefined }
}
