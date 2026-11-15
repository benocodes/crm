// `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset [--email <owner>]` ([[OPS307]] D9, D10): the source twin of `vibase-server owner-reset`, for an instance deployed from the
// repository. The rules are `owner-reset.ts`'s; this file reads the instance's record from `wrangler.jsonc`'s env block and `AUTH_SECRET` from the instance's own gitignored `.env.<env>` (never the root `.env`, which
// holds another instance's values), opens the remote CRM and control databases through wrangler's `getPlatformProxy` as `bootstrap --remote` does, and maps the outcome to bootstrap's exit codes
// (P6: its refusals and its failures both exit 1). No dry run on this path (D9).
import { parseArgs, parseEnv } from 'node:util'
import type { D1Like } from '@vibase/storage-d1'
import { OwnerResetFailure, OwnerResetRefusal, ownerReset, ownerResetLines } from './owner-reset.js'
import { RemoteRefusal, requireConfirm, resolveTarget, type ConfigLike } from './remote.js'
import { providerFromVars } from './setup/better-auth.js'

export const OWNER_RESET_USAGE =
  'usage: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset [--email <owner>]'

export interface OwnerResetRemoteDeps {
  /** Loads the Cloudflare credentials from the root `.env` (and refuses when they are missing). */
  loadEnv(): void
  readConfig(envName: string): ConfigLike & { vars?: Record<string, unknown> }
  /** The instance's own env file `.env.<env>` as `probeEnvFile` reports it. */
  readInstanceEnv(envName: string): {
    display: string
    status: 'ok' | 'missing' | 'not-ignored' | 'root-env'
    text?: string
  }
  getPlatformProxy(envName: string): Promise<{ env: { DB: D1Like; CONTROL_DB?: D1Like }; dispose(): Promise<void> }>
  log(line: string): void
  error(line: string): void
}

/** Returns the exit code: 0 done, 1 refused or failed (bootstrap's own codes). */
export async function runOwnerResetRemote(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: OwnerResetRemoteDeps,
): Promise<number> {
  try {
    let values: { remote?: boolean; env?: string; email?: string; 'owner-reset'?: boolean }
    try {
      values = parseArgs({
        args: argv.filter((a) => a !== '--'),
        strict: true,
        allowPositionals: false,
        options: {
          remote: { type: 'boolean' },
          env: { type: 'string' },
          email: { type: 'string' },
          'owner-reset': { type: 'boolean' },
        },
      }).values
    } catch (e) {
      throw new RemoteRefusal(
        `${e instanceof Error ? e.message : 'bad arguments'}; --owner-reset takes only --remote --env <name> [--email <owner>]; ${OWNER_RESET_USAGE}`,
      )
    }
    if (!values.remote || !values.env)
      throw new RemoteRefusal(`--owner-reset needs --remote and --env <name>; ${OWNER_RESET_USAGE}`)
    requireConfirm(env)
    const envName = values.env
    deps.loadEnv()
    const config = deps.readConfig(envName)
    const target = resolveTarget(config, envName)
    deps.log(`target: env ${target.env}, database ${target.databaseName} (${target.databaseId})`)
    const file = deps.readInstanceEnv(envName)
    if (file.status === 'root-env')
      throw new RemoteRefusal(
        `${file.display} is the root .env, which holds another instance's values: use the instance's own file (.env.${envName})`,
      )
    if (file.status === 'missing')
      throw new RemoteRefusal(
        `${file.display} does not exist: it holds this instance's AUTH_SECRET, which owner-reset needs (setup:remote wrote it there; if the Worker has one, copy it in)`,
      )
    if (file.status === 'not-ignored')
      throw new RemoteRefusal(`${file.display} is not ignored by git: add it to .gitignore before it holds a secret`)
    const authSecret = parseEnv(file.text ?? '').AUTH_SECRET?.trim() || undefined

    const result = await ownerReset({
      record: {
        authProvider: providerFromVars(config.vars, `wrangler.jsonc env ${envName}`),
        hasControl: target.control !== undefined,
        publicBaseUrl: typeof config.vars?.PUBLIC_BASE_URL === 'string' ? config.vars.PUBLIC_BASE_URL : undefined,
      },
      authSecret,
      secretsFile: file.display,
      email: values.email,
      dryRun: false,
      withDatabases: async (fn) => {
        const proxy = await deps.getPlatformProxy(envName)
        try {
          return await fn({ crm: proxy.env.DB, control: proxy.env.CONTROL_DB })
        } finally {
          await proxy.dispose()
        }
      },
    })
    for (const l of ownerResetLines(result)) deps.log(l)
    return 0
  } catch (e) {
    if (e instanceof OwnerResetRefusal || e instanceof OwnerResetFailure || e instanceof RemoteRefusal) {
      deps.error(`bootstrap: ${e.message}`)
      return 1
    }
    throw e
  }
}
