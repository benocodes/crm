// The local D1 bootstrap CLI ([[CORE38]] D7, P8): the deployment marker, then the first organisation, owner and agent key, in
// the local D1 state `wrangler dev` uses (`.wrangler/state`). It opens that state through wrangler's `getPlatformProxy` with
// `remoteBindings: false`, always: there is no flag, and no code path here can reach a remote database.
//
//   pnpm -C packages/server-d1 bootstrap -- --org <name> --email <email> --agent <name> --auth-org-id <clerk org id> \
//     [--scopes a:read,b:write] [--name <user name>] [--auth-provider clerk] [--auth-subject <provider user id>] [--organization-id <uuid>]
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { D1Like } from '@vault/storage-d1'
import { bootstrapD1, type BootstrapD1Result } from '../src/bootstrap-d1.js'
import type { ConfigLike } from './remote.js'

const CONFIG_PATH = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))

/** The options handed to `getPlatformProxy`: the persisted local state, never a remote binding. Exported for a unit test. */
export function proxyOptions(configPath: string = CONFIG_PATH): { configPath: string; persist: boolean; remoteBindings: boolean } {
  return { configPath, persist: true, remoteBindings: false }
}

export function remoteProxyOptions(_envName: string, _configPath?: string): { configPath: string; environment: string; persist: boolean; remoteBindings: boolean } { throw new Error('not implemented') }
export function parseBootstrapArgs(_argv: string[]): { mode: 'local' | 'remote'; values: Record<string, string | undefined>; envName?: string; keyEnv?: string } { throw new Error('not implemented') }
export function appendEnvVar(_text: string, _name: string, _value: string): string { throw new Error('not implemented') }
export function reportLines(_r: BootstrapD1Result, _mode: 'local' | 'remote', _keyEnv?: string): string[] { throw new Error('not implemented') }
export interface RemoteGuardDeps { loadEnv: () => void; readEnvText: () => string; readConfig: () => ConfigLike; getPlatformProxy: (o: unknown) => Promise<unknown>; log?: (line: string) => void }
export async function runRemoteGuards(_parsed: { envName: string; keyEnv: string }, _env: NodeJS.ProcessEnv, _deps: RemoteGuardDeps): Promise<unknown> { throw new Error('not implemented') }

function usage(message: string): never {
  console.error(`bootstrap: ${message}`)
  console.error(
    'usage: pnpm -C packages/server-d1 bootstrap -- --org <name> --email <email> --agent <name> --auth-org-id <clerk org id> [--scopes a:read,b:write] [--name <user name>] [--auth-provider clerk] [--auth-subject <provider user id>] [--organization-id <uuid>]',
  )
  process.exit(1)
}

async function main(): Promise<void> {
  let values: Record<string, string | undefined>
  try {
    values = parseArgs({
      args: process.argv.slice(2).filter((a) => a !== '--'),
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
      },
      strict: true,
    }).values as Record<string, string | undefined>
  } catch (err) {
    usage(err instanceof Error ? err.message : 'bad arguments')
  }
  if (!values.org || !values.email || !values.agent || !values['auth-org-id']) usage('--org, --email, --agent and --auth-org-id are required')

  const { getPlatformProxy } = await import('wrangler')
  const proxy = await getPlatformProxy<{ DB: D1Like }>(proxyOptions())
  try {
    const r = await bootstrapD1(proxy.env.DB, {
      organizationName: values.org,
      email: values.email,
      userName: values.name,
      agentName: values.agent,
      scopes: values.scopes ? values.scopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      authProvider: values['auth-provider'],
      authOrgId: values['auth-org-id'],
      authSubject: values['auth-subject'],
      organizationId: values['organization-id'],
    })
    console.log(`deployment:      ${r.deployment}`)
    console.log(`organization_id: ${r.organizationId}`)
    console.log(`user_id:         ${r.userId}`)
    console.log(`agent_id:        ${r.agentId}`)
    console.log(`api_key_id:      ${r.apiKeyId}`)
    console.log(`api_key:         ${r.key}   (shown once)`)
  } catch (err) {
    console.error('bootstrap failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await proxy.dispose()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
