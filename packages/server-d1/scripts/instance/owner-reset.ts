// `vibase-server owner-reset --env <name> [--email <owner>] [--dry-run] [--settings <p>] [--secrets-file <p>]` ([[OPS307]] D9, D10): an operator holding the instance's Cloudflare credentials gets a one-time
// owner reset link (or, with no owner left, an owner invitation) printed once. The rules are `../owner-reset.ts`'s, shared with the source twin (`bootstrap --remote --owner-reset`); this file reads the
// settings and secrets files, opens the remote databases through the installed package's own wrangler (as `setup`'s bootstrap does) and maps the outcome to the exit codes.
// Exit 0: done (or the dry run is complete); 2: refused before any write; 3: failed after a write began.
import { parseArgs } from 'node:util'
import { requireConfirm } from '../remote.js'
import { OwnerResetFailure, OwnerResetRefusal, ownerReset, ownerResetLines } from '../owner-reset.js'
import { providerFromVars } from '../setup/better-auth.js'
import { withGeneratedConfigAsync } from './config.js'
import { childEnv } from './gate.js'
import { defaultSecretsPath, loadSecrets, parseDotenv } from './secrets.js'
import { defaultSettingsPath, loadSettings } from './settings.js'
import { InstanceRefusal, isRefusal, type InstanceDeps } from './types.js'

export const EXIT_DONE = 0
export const EXIT_REFUSED = 2
export const EXIT_FAILED = 3

const USAGE = 'usage: vibase-server owner-reset --env <name> [--email <owner>] [--dry-run] [--settings <path>] [--secrets-file <path>]'

export async function runOwnerReset(argv: string[], deps: InstanceDeps): Promise<number> {
  let redact = (t: string): string => t
  try {
    let values: { env?: string; email?: string; settings?: string; 'secrets-file'?: string; 'dry-run'?: boolean }
    try {
      values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { env: { type: 'string' }, email: { type: 'string' }, settings: { type: 'string' }, 'secrets-file': { type: 'string' }, 'dry-run': { type: 'boolean' } } }).values
    } catch (e) {
      throw new InstanceRefusal(`${e instanceof Error ? e.message : 'bad arguments'}; ${USAGE}`)
    }
    if (!values.env) throw new InstanceRefusal(`--env <name> is required; ${USAGE}`)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(values.env)) throw new InstanceRefusal(`--env ${values.env} is not an environment name (lowercase letters, digits and dashes)`)
    const dryRun = values['dry-run'] === true
    if (!dryRun) requireConfirm(deps.env as NodeJS.ProcessEnv)

    const settingsPath = values.settings ?? defaultSettingsPath(deps.env, deps.homedir, values.env)
    const settings = loadSettings(settingsPath, values.env)
    const secretsPath = values['secrets-file'] ?? defaultSecretsPath(deps.env, deps.homedir, values.env)
    const secrets = loadSecrets(secretsPath, deps.env)
    redact = secrets.redact
    // The instance's own AUTH_SECRET comes from the secrets file alone (OPS249 D3), never from the process environment.
    const authSecret = parseDotenv(secrets.text).AUTH_SECRET?.trim() || undefined

    const result = await ownerReset({
      record: { authProvider: providerFromVars(settings.vars, settingsPath), hasControl: settings.control_d1 !== undefined, publicBaseUrl: settings.vars.PUBLIC_BASE_URL },
      authSecret,
      secretsFile: secretsPath,
      email: values.email,
      dryRun,
      withDatabases: (fn) =>
        withGeneratedConfigAsync({ packageDir: deps.packageDir, settings, tmpRoot: deps.tmpRoot }, async (configPath) => {
          const { d1, control, dispose } = await deps.openD1({ configPath, remoteBindings: true, persist: false, env: childEnv(deps, secrets) })
          try {
            return await fn({ crm: d1, control })
          } finally {
            await dispose()
          }
        }),
    })
    for (const l of ownerResetLines(result)) deps.out(l)
    return EXIT_DONE
  } catch (e) {
    if (e instanceof OwnerResetFailure) {
      deps.err(`vibase-server owner-reset: ${redact(e.message)}`)
      return EXIT_FAILED
    }
    if (e instanceof OwnerResetRefusal || isRefusal(e)) {
      deps.err(`vibase-server owner-reset: ${redact((e as Error).message)}`)
      return EXIT_REFUSED
    }
    throw e
  }
}
