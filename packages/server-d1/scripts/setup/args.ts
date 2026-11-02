import { parseArgs } from 'node:util'
import { RemoteRefusal } from '../remote.js'
import { STEP_NAMES, type SetupOptions, type StepName } from './types.js'

const ENV_SHAPE = /^[a-z0-9][a-z0-9-]*$/
const KEY_ENV_SHAPE = /^[A-Z][A-Z0-9_]*$/
const HOST_SHAPE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const OPS87_FLAGS = ['clerk-publishable-key', 'clerk-key-env', 'no-dcr', 'rotate-secrets']

/** One `https://` origin, no path, no wildcard ([[OPS65]] D20). */
export function validateOrigin(flag: string, value: string): string {
  if (value.includes('*')) throw new RemoteRefusal(`${flag} ${value}: wildcards are not allowed, list each origin`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RemoteRefusal(`${flag} ${value}: not a URL; expected https://host[:port]`)
  }
  if (url.protocol !== 'https:') throw new RemoteRefusal(`${flag} ${value}: must be an https:// origin`)
  if (value !== url.origin) throw new RemoteRefusal(`${flag} ${value}: must be an origin with no path, query or trailing slash (${url.origin})`)
  return value
}

/** Parses and validates the flags ([[OPS65]] D6, D18, D19, D20) before anything touches a network; throws `RemoteRefusal`. */
export function parseSetupArgs(argv: string[]): SetupOptions {
  let values: ReturnType<typeof parseArgs>['values']
  try {
    ;({ values } = parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        env: { type: 'string' },
        'api-host': { type: 'string' },
        auth: { type: 'string' },
        org: { type: 'string' },
        'web-origin': { type: 'string' },
        'extra-origin': { type: 'string', multiple: true },
        'operator-agent': { type: 'string' },
        'key-env': { type: 'string' },
        'owner-email': { type: 'string' },
        'worker-name': { type: 'string' },
        'd1-name': { type: 'string' },
        'r2-name': { type: 'string' },
        only: { type: 'string' },
        'dry-run': { type: 'boolean' },
        ...Object.fromEntries(OPS87_FLAGS.map((f) => [f, { type: 'string' as const }])),
      },
      strict: true,
    }))
  } catch (err) {
    throw new RemoteRefusal(err instanceof Error ? err.message : 'bad arguments')
  }
  const str = (k: string) => values[k] as string | undefined
  for (const f of OPS87_FLAGS) if (values[f] !== undefined) throw new RemoteRefusal(`--${f} belongs to the Clerk side of setup, which arrives with OPS87 (#87)`)

  const env = str('env')
  if (!env) throw new RemoteRefusal('--env <name> is required')
  if (!ENV_SHAPE.test(env)) throw new RemoteRefusal(`--env ${env}: lower-case letters, digits and dashes only`)
  const apiHost = str('api-host')
  if (!apiHost) throw new RemoteRefusal('--api-host <host> is required (the API is served on a custom domain, OPS65 D19)')
  if (apiHost.includes('*') || !HOST_SHAPE.test(apiHost)) throw new RemoteRefusal(`--api-host ${apiHost}: expected a bare host name such as api.example.com (no scheme, path or wildcard)`)

  const auth = str('auth')
  if (auth === 'clerk') throw new RemoteRefusal('--auth clerk is not available yet: the Clerk side is OPS87 (#87); run with --auth none')
  if (auth !== 'none') throw new RemoteRefusal('pass --auth none explicitly (the clerk default arrives with OPS87)')

  const operatorAgent = str('operator-agent')
  const keyEnv = str('key-env')
  if ((operatorAgent === undefined) !== (keyEnv === undefined)) throw new RemoteRefusal('--operator-agent and --key-env go together')
  if (keyEnv !== undefined && !KEY_ENV_SHAPE.test(keyEnv)) throw new RemoteRefusal(`--key-env ${keyEnv} must be UPPER_SNAKE_CASE`)
  const ownerEmail = str('owner-email')
  if (operatorAgent !== undefined && !ownerEmail) throw new RemoteRefusal('--owner-email is required with --operator-agent on --auth none (the API-key deployment needs a human owner, as bootstrap does)')

  if (str('org') !== undefined && operatorAgent === undefined) throw new RemoteRefusal('--org only applies with --operator-agent on --auth none (without it only the deployment marker is written)')

  const web = str('web-origin')
  const origins = [...(web ? [validateOrigin('--web-origin', web)] : []), ...((values['extra-origin'] as string[] | undefined) ?? []).map((o) => validateOrigin('--extra-origin', o))]

  let only: StepName[] | undefined
  const onlyRaw = str('only')
  if (onlyRaw !== undefined) {
    only = onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) as StepName[]
    const unknown = only.filter((s) => !(STEP_NAMES as readonly string[]).includes(s))
    if (unknown.length > 0 || only.length === 0) throw new RemoteRefusal(`--only: unknown step ${unknown.join(', ') || '(none given)'}; steps are ${STEP_NAMES.join(', ')}`)
  }

  return {
    env,
    apiHost,
    auth: 'none',
    org: str('org') ?? env,
    origins,
    operatorAgent,
    keyEnv,
    ownerEmail,
    workerName: str('worker-name') ?? `vault-${env}`,
    d1Name: str('d1-name') ?? `vault-${env}`,
    r2Name: str('r2-name') ?? `vault-${env}-bodies`,
    only,
    dryRun: values['dry-run'] === true,
  }
}
