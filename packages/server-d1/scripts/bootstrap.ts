// The D1 bootstrap CLI ([[CORE38]] D7, P8; [[OPS4]] C7, D17): the deployment marker, then the first organisation, owner and agent
// key. Local unless `--remote --env <name>` and `CONFIRM_REMOTE=1`: local mode opens the state `wrangler dev` uses
// (`.wrangler/state`) through wrangler's `getPlatformProxy` with `remoteBindings: false` and prints the key. Remote mode opens
// the named instance's database, proves `batch()` atomic first, writes the key to the root `.env` as the variable named by
// `--key-env`, and never prints it.
//
//   pnpm -C packages/server-d1 bootstrap -- --org <name> --email <email> --agent <name> --auth-org-id <clerk org id> \
//     [--scopes a:read,b:write] [--name <user name>] [--auth-provider clerk] [--auth-subject <provider user id>] [--organization-id <uuid>]
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --key-env <NAME> --org ... (same flags)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { uuidv7 } from '@vault/storage'
import type { D1Like } from '@vault/storage-d1'
import { bootstrapD1, probeBatchAtomicity, type BootstrapD1Result } from '../src/bootstrap-d1.js'
import { CONFIG_PATH, ROOT_ENV_PATH, RemoteRefusal, loadRootEnv, requireConfirm, resolveTarget, type ConfigLike, type Target } from './remote.js'

type Values = Record<string, string | undefined>

/** The options handed to `getPlatformProxy` locally: the persisted local state, never a remote binding. Exported for a unit test. */
export function proxyOptions(configPath: string = CONFIG_PATH): { configPath: string; persist: boolean; remoteBindings: boolean } {
  return { configPath, persist: true, remoteBindings: false }
}

/** The options for a named instance: its environment, its remote database, nothing persisted locally. */
export function remoteProxyOptions(envName: string, configPath: string = CONFIG_PATH): { configPath: string; environment: string; persist: boolean; remoteBindings: boolean } {
  return { configPath, environment: envName, persist: false, remoteBindings: true }
}

const KEY_ENV_SHAPE = /^[A-Z][A-Z0-9_]*$/
const USAGE =
  'usage: pnpm -C packages/server-d1 bootstrap -- --org <name> --email <email> --agent <name> --auth-org-id <clerk org id> [--scopes a:read,b:write] [--name <user name>] [--auth-provider clerk] [--auth-subject <provider user id>] [--organization-id <uuid>] [--remote --env <name> --key-env <NAME>]'

export function parseBootstrapArgs(argv: string[]): { mode: 'local' | 'remote'; values: Values; envName?: string; keyEnv?: string } {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      org: { type: 'string' },
      email: { type: 'string' },
      agent: { type: 'string' },
      'auth-org-id': { type: 'string' },
      scopes: { type: 'string' },
      name: { type: 'string' },
      'auth-provider': { type: 'string' },
      'auth-subject': { type: 'string' },
      'organization-id': { type: 'string' },
      remote: { type: 'boolean' },
      env: { type: 'string' },
      'key-env': { type: 'string' },
    },
    strict: true,
  })
  const { remote, env, 'key-env': keyEnv, ...rest } = values
  if (!remote) {
    if (env !== undefined || keyEnv !== undefined) throw new Error('--env and --key-env only apply with --remote')
    return { mode: 'local', values: rest as Values }
  }
  if (!env || !keyEnv) throw new RemoteRefusal('--remote requires --env <name> and --key-env <NAME>')
  if (!KEY_ENV_SHAPE.test(keyEnv)) throw new RemoteRefusal(`--key-env ${keyEnv} must be UPPER_SNAKE_CASE`)
  return { mode: 'remote', values: rest as Values, envName: env, keyEnv }
}

const assigned = (text: string, name: string) => new RegExp(`^\\s*(export\\s+)?${name}=`, 'm').test(text)

export function appendEnvVar(text: string, name: string, value: string): string {
  if (assigned(text, name)) throw new RemoteRefusal(`${name} is already set in .env: refusing to overwrite a key`)
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${value}\n`
}

export function reportLines(r: BootstrapD1Result, mode: 'local' | 'remote', keyEnv?: string): string[] {
  return [
    `deployment:      ${r.deployment}`,
    `organization_id: ${r.organizationId}`,
    `user_id:         ${r.userId}`,
    `agent_id:        ${r.agentId}`,
    `api_key_id:      ${r.apiKeyId}`,
    mode === 'local' ? `api_key:         ${r.key}   (shown once)` : `api_key: written to .env as ${keyEnv} (not shown)`,
  ]
}

export interface RemoteGuardDeps {
  loadEnv: () => void
  readEnvText: () => string
  readConfig: () => ConfigLike
  getPlatformProxy: (options: ReturnType<typeof remoteProxyOptions>) => Promise<{ env: { DB: D1Like }; dispose(): Promise<void> }>
  log?: (line: string) => void
}

/** C7 steps 1-3 in order: every guard first, the target line, and only then the remote proxy. */
export async function runRemoteGuards(
  parsed: { envName: string; keyEnv: string },
  env: NodeJS.ProcessEnv,
  deps: RemoteGuardDeps,
): Promise<{ target: Target; proxy: Awaited<ReturnType<RemoteGuardDeps['getPlatformProxy']>> }> {
  requireConfirm(env)
  deps.loadEnv()
  if (!KEY_ENV_SHAPE.test(parsed.keyEnv)) throw new RemoteRefusal(`--key-env ${parsed.keyEnv} must be UPPER_SNAKE_CASE`)
  if (assigned(deps.readEnvText(), parsed.keyEnv)) throw new RemoteRefusal(`${parsed.keyEnv} is already set in .env: refusing to overwrite a key`)
  const target = resolveTarget(deps.readConfig(), parsed.envName)
  ;(deps.log ?? console.log)(`target: env ${target.env}, database ${target.databaseName} (${target.databaseId})`)
  const proxy = await deps.getPlatformProxy(remoteProxyOptions(parsed.envName))
  return { target, proxy }
}

function usage(message: string): never {
  console.error(`bootstrap: ${message}`)
  console.error(USAGE)
  process.exit(1)
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseBootstrapArgs>
  try {
    parsed = parseBootstrapArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof RemoteRefusal) {
      console.error(`bootstrap: ${err.message}`)
      process.exit(1)
    }
    usage(err instanceof Error ? err.message : 'bad arguments')
  }
  const { values } = parsed
  if (!values.org || !values.email || !values.agent || !values['auth-org-id']) usage('--org, --email, --agent and --auth-org-id are required')

  const { getPlatformProxy, unstable_readConfig } = await import('wrangler')
  let proxy: Awaited<ReturnType<RemoteGuardDeps['getPlatformProxy']>>
  let organizationId = values['organization-id']
  if (parsed.mode === 'remote') {
    try {
      const guarded = await runRemoteGuards({ envName: parsed.envName!, keyEnv: parsed.keyEnv! }, process.env, {
        loadEnv: () => loadRootEnv(),
        readEnvText: () => {
          try {
            return readFileSync(ROOT_ENV_PATH, 'utf8')
          } catch {
            return ''
          }
        },
        readConfig: () => unstable_readConfig({ config: CONFIG_PATH, env: parsed.envName }) as unknown as ConfigLike,
        getPlatformProxy: (o) => getPlatformProxy<{ DB: D1Like }>(o),
      })
      proxy = guarded.proxy
    } catch (err) {
      if (!(err instanceof RemoteRefusal)) throw err
      console.error(`bootstrap: ${err.message}`)
      process.exit(1)
    }
  } else {
    proxy = await getPlatformProxy<{ DB: D1Like }>(proxyOptions())
  }
  try {
    const authProvider = values['auth-provider']
    if (parsed.mode === 'remote') {
      const link = { organizationId: values['organization-id'] ?? uuidv7(), authProvider: authProvider ?? 'clerk', authOrgId: values['auth-org-id'] }
      const probe = await probeBatchAtomicity(proxy.env.DB, link)
      if (probe === 'not-atomic') {
        console.error('atomicity probe: FAILED (a failed batch left a row): stopping')
        process.exitCode = 1
        return
      }
      console.log(probe === 'atomic' ? 'atomicity probe: atomic' : 'atomicity probe: skipped (marker present)')
      organizationId = probe === 'atomic' ? link.organizationId : values['organization-id']
    }
    const r = await bootstrapD1(proxy.env.DB, {
      organizationName: values.org,
      email: values.email,
      userName: values.name,
      agentName: values.agent,
      scopes: values.scopes ? values.scopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      authProvider,
      authOrgId: values['auth-org-id'],
      authSubject: values['auth-subject'],
      organizationId,
    })
    if (parsed.mode === 'remote') {
      try {
        writeFileSync(ROOT_ENV_PATH, appendEnvVar(readFileSync(ROOT_ENV_PATH, 'utf8'), parsed.keyEnv!, r.key))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
        console.error(`api_key: could not be written to .env (${code}); the key is lost: revoke api key ${r.apiKeyId} and create a new one`)
        process.exitCode = 1
        return
      }
    }
    for (const line of reportLines(r, parsed.mode, parsed.keyEnv)) console.log(line)
  } catch (err) {
    console.error('bootstrap failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await proxy.dispose()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
