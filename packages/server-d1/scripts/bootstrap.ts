// The D1 bootstrap CLI ([[CORE38]] D7, P8; [[OPS4]] C7, D17; [[CORE64]] D11): the deployment marker, then the first organisation and
// the operator agent key. On a Clerk-backed deployment (the default provider) it creates NO human: the owner is invited in Clerk, and
// the marker's link is the Clerk issuer (`--issuer`, the Worker's CLERK_ISSUER). `--auth-provider none` (API keys only, `smoked1`)
// keeps creating its owner user from `--email` and `--auth-org-id <name>`. Local unless `--remote --env <name>` and `CONFIRM_REMOTE=1`: local mode opens the state `wrangler dev` uses
// (`.wrangler/state`) through wrangler's `getPlatformProxy` with `remoteBindings: false` and prints the key. Remote mode opens
// the named instance's database, proves `batch()` atomic first, writes the key to the root `.env` as the variable named by
// `--key-env`, and never prints it.
//
//   pnpm -C packages/server-d1 bootstrap -- --org <name> --issuer <CLERK_ISSUER> [--agent <name>] [--scopes a:read,b:write] [--organization-id <uuid>]
//   pnpm -C packages/server-d1 bootstrap -- --org <name> --auth-provider better-auth --public-base-url <PUBLIC_BASE_URL> [--auth-org-id <name>] [--agent <name>] [--owner-email <email>]   (no human; seeds vibase-cli, CORE283; --owner-email issues the first owner invitation and prints its URL once, CORE245 P7)
//   pnpm -C packages/server-d1 bootstrap -- --org <name> --auth-provider none --auth-org-id <name> --email <email> --agent <name>
//   CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --key-env <NAME> --org ... (same flags)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { uuidv7 } from '@vibase/storage'
import { openControlDb, type ControlDb, type D1Like } from '@vibase/storage-d1'
import { bootstrapD1, probeBatchAtomicity, type BootstrapD1Result } from '../src/bootstrap-d1.js'
import { CONFIG_PATH, ROOT_ENV_PATH, RemoteRefusal, controlNotConfigured, loadRootEnv, requireConfirm, resolveTarget, type ConfigLike, type Target } from './remote.js'

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
  'usage: pnpm -C packages/server-d1 bootstrap -- --org <name> --issuer <CLERK_ISSUER> [--agent <name>] [--scopes a:read,b:write] [--organization-id <uuid>] [--remote --env <name> --key-env <NAME>]\n   or: ... --org <name> --auth-provider better-auth --public-base-url <PUBLIC_BASE_URL> [--auth-org-id <name>] [--agent <name>] [--owner-email <email>]   (seeds the vibase-cli client; no human; --owner-email issues the first owner invitation, its URL printed once)\n   or: ... --org <name> --auth-provider none --auth-org-id <name> --email <email> --agent <name> [--name <user name>]'

export function parseBootstrapArgs(argv: string[]): { mode: 'local' | 'remote'; values: Values; envName?: string; keyEnv?: string } {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      org: { type: 'string' },
      email: { type: 'string' },
      agent: { type: 'string' },
      'auth-org-id': { type: 'string' },
      issuer: { type: 'string' },
      scopes: { type: 'string' },
      name: { type: 'string' },
      'auth-provider': { type: 'string' },
      'auth-subject': { type: 'string' },
      'organization-id': { type: 'string' },
      'public-base-url': { type: 'string' },
      'owner-email': { type: 'string' },
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
    ...(r.userId === null ? [] : [`user_id:         ${r.userId}`]),
    ...(r.ownerInvitation === undefined ? [] : r.ownerInvitation === null ? ['owner_invitation: none issued: an owner already exists'] : [`owner_invitation: ${r.ownerInvitation.url}   (shown once; expires ${r.ownerInvitation.expiresAt}; ${r.ownerInvitation.revoked.length > 0 ? 'it replaced a live owner invitation' : 'send it to the owner'})`]),
    ...(r.organizationExisted ? ['organization:   already initialised: no agent or key was created (--agent is ignored on a re-run)'] : r.key === null ? ['agent:           none (no --agent given)'] : [`agent_id:        ${r.agentId}`, `api_key_id:      ${r.apiKeyId}`, mode === 'local' ? `api_key:         ${r.key}   (shown once)` : `api_key: written to .env as ${keyEnv} (not shown)`]),
  ]
}

export interface RemoteGuardDeps {
  loadEnv: () => void
  readEnvText: () => string
  readConfig: () => ConfigLike
  getPlatformProxy: (options: ReturnType<typeof remoteProxyOptions>) => Promise<{ env: { DB: D1Like; CONTROL_DB?: D1Like }; dispose(): Promise<void> }>
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

export interface BootstrapRun {
  mode: 'local' | 'remote'
  keyEnv?: string
  values: Values
  authOrgId: string
  /** The remote target (`runRemoteGuards`); absent locally. */
  target?: Target
}
export interface BootstrapIo {
  log(line: string): void
  error(line: string): void
  readEnvText(): string
  writeEnvText(text: string): void
}
/**
 * OPS279: the body of `main` once the proxy is open, as a function a test can call; returns the exit code. A remote env whose config binds `CONTROL_DB` pairs the control
 * database ([[CORE259]] D7): the marker follows the CRM row, and `bootstrapD1` refuses a marker for another organisation before either database is written (the atomicity probe leaves nothing when it passes). An env
 * that binds none stays CRM only and says so ([[CORE259]] P1). Locally the control database is paired when the local env binds one, as before.
 */
export async function runBootstrap(run: BootstrapRun, proxy: { env: { DB: D1Like; CONTROL_DB?: D1Like } }, io: BootstrapIo): Promise<number> {
  const { values, authOrgId } = run
  const authProvider = values['auth-provider']
  let control: ControlDb | undefined
  if (run.mode === 'remote') {
    const target = run.target!
    if (!target.control) io.log(controlNotConfigured(target.env))
    else if (!proxy.env.CONTROL_DB) {
      io.error(`bootstrap: env ${target.env} binds CONTROL_DB in wrangler.jsonc but the remote proxy has none: nothing was written`)
      return 1
    } else control = openControlDb(proxy.env.CONTROL_DB)
  } else if (proxy.env.CONTROL_DB) control = openControlDb(proxy.env.CONTROL_DB)
  try {
    let organizationId = values['organization-id']
    if (run.mode === 'remote') {
      const link = { organizationId: values['organization-id'] ?? uuidv7(), authProvider: authProvider ?? 'clerk', authOrgId }
      const probe = await probeBatchAtomicity(proxy.env.DB, link)
      if (probe === 'not-atomic') {
        io.error('atomicity probe: FAILED (a failed batch left a row): stopping')
        return 1
      }
      io.log(probe === 'atomic' ? 'atomicity probe: atomic' : 'atomicity probe: skipped (marker present)')
      organizationId = probe === 'atomic' ? link.organizationId : values['organization-id']
    }
    const r = await bootstrapD1(
      proxy.env.DB,
      {
        organizationName: values.org!,
        email: values.email,
        userName: values.name,
        agentName: values.agent,
        scopes: values.scopes ? values.scopes.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
        authProvider,
        authOrgId,
        authSubject: values['auth-subject'],
        organizationId,
        publicBaseUrl: values['public-base-url'],
        ownerEmail: values['owner-email'],
      },
      // [[CORE259]] D7: the control marker follows the CRM deployment row.
      { control },
    )
    if (run.mode === 'remote' && r.key !== null) {
      try {
        io.writeEnvText(appendEnvVar(io.readEnvText(), run.keyEnv!, r.key))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
        io.error(`api_key: could not be written to .env (${code}); the key is lost: revoke api key ${r.apiKeyId} and create a new one`)
        return 1
      }
    }
    for (const line of reportLines(r, run.mode, run.keyEnv)) io.log(line)
    return 0
  } catch (err) {
    io.error(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
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
  const provider = values['auth-provider'] ?? 'clerk'
  if (values.issuer !== undefined && values['auth-org-id'] !== undefined) usage('pass --issuer or --auth-org-id, not both')
  // `better-auth` ([[CORE283]] P5): the marker's link is a label, `better-auth` unless --auth-org-id says otherwise; --public-base-url names the seeded client's resources.
  const authOrgId = values.issuer ?? values['auth-org-id'] ?? (provider === 'better-auth' ? 'better-auth' : undefined)
  if (!values.org || !authOrgId) usage(provider === 'clerk' ? '--org and --issuer are required' : '--org and --auth-org-id are required')
  if (provider === 'better-auth' && !values['public-base-url']) usage('--auth-provider better-auth requires --public-base-url <PUBLIC_BASE_URL>')
  if (provider === 'better-auth' && values.issuer !== undefined) usage('--issuer is for Clerk: drop it')
  if (values['owner-email'] !== undefined && provider !== 'better-auth') usage('--owner-email applies to --auth-provider better-auth only')
  if ((provider === 'clerk' || provider === 'better-auth') && (values.email !== undefined || values.name !== undefined || values['auth-subject'] !== undefined)) {
    usage(`a ${provider === 'clerk' ? 'Clerk' : 'Better Auth'}-backed deployment creates no human: drop --email, --name and --auth-subject`)
  }
  if (provider !== 'clerk' && provider !== 'better-auth' && (!values.email || !values.agent)) usage(`--auth-provider ${provider} requires --email and --agent`)

  const { getPlatformProxy, unstable_readConfig } = await import('wrangler')
  let proxy: Awaited<ReturnType<RemoteGuardDeps['getPlatformProxy']>>
  let target: Target | undefined
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
        getPlatformProxy: (o) => getPlatformProxy<{ DB: D1Like; CONTROL_DB?: D1Like }>(o),
      })
      proxy = guarded.proxy
      target = guarded.target
    } catch (err) {
      if (!(err instanceof RemoteRefusal)) throw err
      console.error(`bootstrap: ${err.message}`)
      process.exit(1)
    }
  } else {
    proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB?: D1Like }>(proxyOptions())
  }
  try {
    process.exitCode = await runBootstrap({ mode: parsed.mode, keyEnv: parsed.keyEnv, values, authOrgId: authOrgId!, target }, proxy, {
      log: (l) => console.log(l),
      error: (l) => console.error(l),
      readEnvText: () => readFileSync(ROOT_ENV_PATH, 'utf8'),
      writeEnvText: (t) => writeFileSync(ROOT_ENV_PATH, t),
    })
  } finally {
    await proxy.dispose()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
