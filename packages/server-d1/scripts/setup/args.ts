import { parseArgs } from 'node:util'
import { RemoteRefusal } from '../remote.js'
import { PROVIDERS, chooseProvider, type RecordLookup } from './better-auth.js'
import { SUBDOMAIN_SHAPE, hostChangeRefusal, isWorkersDevHost, recordedMode } from './host.js'
import { CLERK_ONLY_STEPS, STEP_NAMES, type SetupOptions, type StepName } from './types.js'

const ENV_SHAPE = /^[a-z0-9][a-z0-9-]*$/
const KEY_ENV_SHAPE = /^[A-Z][A-Z0-9_]*$/
const HOST_SHAPE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
/** Flags that only mean something with `--auth clerk` ([[OPS65]] Inputs). `--clerk-env-file` and `--rotate-secrets` also serve the Gmail group on `--auth none` ([[OPS65]] D41). */
const CLERK_FLAGS = ['clerk-publishable-key', 'clerk-production', 'no-dcr']

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
  if (value !== url.origin)
    throw new RemoteRefusal(`${flag} ${value}: must be an origin with no path, query or trailing slash (${url.origin})`)
  return value
}

type FlagValues = ReturnType<typeof parseArgs>['values']
type Extra = Record<string, { type: 'string' | 'boolean'; short?: string }>

/**
 * The flags both setup commands share. `extra` adds the ones that differ: `--clerk-env-file` for `setup:remote`, `--settings` and
 * `--secrets-file` for `vibase-server setup` ([[OPS232]] P1). An unknown flag is a refusal.
 */
export function parseSetupFlags(argv: string[], extra: Extra): FlagValues {
  try {
    return parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        env: { type: 'string' },
        'api-host': { type: 'string' },
        'workers-dev': { type: 'boolean' },
        'register-workers-subdomain': { type: 'string' },
        'change-host': { type: 'boolean' },
        auth: { type: 'string' },
        org: { type: 'string' },
        'web-origin': { type: 'string' },
        'extra-origin': { type: 'string', multiple: true },
        'operator-agent': { type: 'string' },
        'key-env': { type: 'string' },
        'owner-email': { type: 'string' },
        'worker-name': { type: 'string' },
        'd1-name': { type: 'string' },
        'control-d1-name': { type: 'string' },
        'r2-name': { type: 'string' },
        only: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'clerk-publishable-key': { type: 'string' },
        'clerk-production': { type: 'boolean' },
        'no-dcr': { type: 'boolean' },
        'rotate-secrets': { type: 'boolean' },
        ...extra,
      },
      strict: true,
    }).values
  } catch (err) {
    throw new RemoteRefusal(err instanceof Error ? err.message : 'bad arguments')
  }
}

/** Parses and validates the flags ([[OPS65]] D6, D18, D19, D20) before anything touches a network; throws `RemoteRefusal`. */
export function parseSetupArgs(argv: string[], record?: RecordLookup): SetupOptions {
  // `--replace-instance` is `setup:remote`'s alone ([[OPS250]] D12, P2): `vibase-server setup` does not list it, so its parser refuses it as unknown.
  return buildSetupOptions(
    parseSetupFlags(argv, { 'clerk-env-file': { type: 'string' }, 'replace-instance': { type: 'string' } }),
    record,
  )
}

/**
 * The validation and defaults of the parsed flags; shared with `vibase-server setup`. `record` finds the instance's recorded provider ([[OPS249]] D1): a recorded
 * instance runs with it and refuses a differing `--auth`; a new one defaults to `better-auth`.
 */
export function buildSetupOptions(values: FlagValues, record?: RecordLookup): SetupOptions {
  const str = (k: string) => values[k] as string | undefined

  const env = str('env')
  if (!env) throw new RemoteRefusal('--env <name> is required')
  if (!ENV_SHAPE.test(env)) throw new RemoteRefusal(`--env ${env}: lower-case letters, digits and dashes only`)
  const apiHostFlag = str('api-host')
  const workersDev = values['workers-dev'] === true
  const registerSubdomain = str('register-workers-subdomain')
  const changeHost = values['change-host'] === true
  // [[OPS249]] D12: exactly one of the two host flags; the host of a workers.dev instance is derived, so a typed one under workers.dev is refused naming the flag.
  if (apiHostFlag === undefined && !workersDev)
    throw new RemoteRefusal(
      'give --api-host <host> (a custom domain on a zone in your account) or --workers-dev (no domain: <worker>.<subdomain>.workers.dev)',
    )
  if (apiHostFlag !== undefined && workersDev)
    throw new RemoteRefusal('--api-host and --workers-dev are exclusive: give exactly one')
  if (apiHostFlag !== undefined) {
    if (apiHostFlag.includes('*') || !HOST_SHAPE.test(apiHostFlag))
      throw new RemoteRefusal(
        `--api-host ${apiHostFlag}: expected a bare host name such as api.example.com (no scheme, path or wildcard)`,
      )
    if (isWorkersDevHost(apiHostFlag))
      throw new RemoteRefusal(
        `--api-host ${apiHostFlag}: a workers.dev host is derived from the account subdomain and the worker name, so it cannot be typed: use --workers-dev`,
      )
  }
  if (registerSubdomain !== undefined) {
    if (!workersDev) throw new RemoteRefusal('--register-workers-subdomain only applies with --workers-dev')
    if (!SUBDOMAIN_SHAPE.test(registerSubdomain))
      throw new RemoteRefusal(
        `--register-workers-subdomain ${registerSubdomain}: expected one lower-case DNS label (letters, digits and dashes)`,
      )
  }

  const flagAuth = str('auth')
  if (flagAuth !== undefined && !(PROVIDERS as readonly string[]).includes(flagAuth))
    throw new RemoteRefusal(
      `--auth ${flagAuth}: expected better-auth (the default for a new instance), clerk or none (API keys only)`,
    )
  // [[OPS250]] D12: `--replace-instance <env>` sets the record aside (names, provider, host), so the run is judged as a new instance's; the flag's own refusals come first.
  const replaceValue = str('replace-instance')
  if (replaceValue !== undefined) {
    if (replaceValue !== env)
      throw new RemoteRefusal(`--replace-instance ${replaceValue}: must equal --env ${env} (the instance it replaces)`)
    let hasRecord = true
    try {
      hasRecord = (record?.(env) ?? null) !== null
    } catch (err) {
      if (!(err instanceof RemoteRefusal)) throw err // a record that setup cannot read is still a record
    }
    if (!hasRecord)
      throw new RemoteRefusal(
        `--replace-instance ${env}: env ${env} has no record in wrangler.jsonc, so there is nothing to replace (use setup without the flag)`,
      )
  }
  const recorded = replaceValue !== undefined ? null : (record?.(env) ?? null)
  const auth = chooseProvider(flagAuth, recorded)
  // [[OPS308]] D12, D14, P4, P6: what the host flags may do on this instance, judged against its record before any call.
  if (workersDev && auth === 'clerk')
    throw new RemoteRefusal(
      '--workers-dev is refused with --auth clerk: a Clerk production instance needs a custom domain',
    )
  if (changeHost && auth === 'clerk')
    throw new RemoteRefusal(
      '--change-host is refused on a Clerk instance: its production domain is dashboard state setup does not move',
    )
  if (changeHost && recorded === null)
    throw new RemoteRefusal(
      '--change-host only applies to an instance that already has a record (a new instance has no host to change)',
    )
  const recordedHost = recorded?.host
  if (recordedHost !== undefined) {
    const mode = recordedMode(recordedHost)
    if (workersDev && mode === 'custom')
      throw new RemoteRefusal(
        '--workers-dev: this instance is on a custom domain; moving back to workers.dev is not offered by setup (a re-run of --workers-dev would need a new instance)',
      )
    if (
      apiHostFlag !== undefined &&
      !changeHost &&
      (mode === 'workers-dev' || (recordedHost.apiHost !== undefined && recordedHost.apiHost !== apiHostFlag))
    ) {
      throw new RemoteRefusal(
        hostChangeRefusal(
          `--api-host ${apiHostFlag}`,
          `this instance is recorded on ${recordedHost.apiHost ?? 'workers.dev'} in ${recorded!.where}`,
        ),
      )
    }
  }
  if (auth !== 'clerk')
    for (const f of CLERK_FLAGS)
      if (values[f] !== undefined) throw new RemoteRefusal(`--${f} only applies with --auth clerk`)

  const operatorAgent = str('operator-agent')
  const keyEnv = str('key-env')
  if ((operatorAgent === undefined) !== (keyEnv === undefined))
    throw new RemoteRefusal('--operator-agent and --key-env go together')
  if (keyEnv !== undefined && !KEY_ENV_SHAPE.test(keyEnv))
    throw new RemoteRefusal(`--key-env ${keyEnv} must be UPPER_SNAKE_CASE`)
  const ownerEmail = str('owner-email')
  // `--owner-email` follows the auth mode ([[OPS65]] D38): the invitation target with clerk, the API-key owner with none.
  if (auth === 'clerk' && !ownerEmail)
    throw new RemoteRefusal('--owner-email is required with --auth clerk (the first owner is invited, OPS65 D17)')
  // [[OPS249]] D6: a new better-auth instance has no owner yet, so it needs the address its owner invitation goes to; a recorded one needs it only while it has no owner (the bootstrap step reads that).
  if (auth === 'better-auth' && recorded === null && !ownerEmail)
    throw new RemoteRefusal(
      '--owner-email is required for a new better-auth instance (the first owner is invited; a recorded instance needs it only while it has no owner)',
    )
  if (auth === 'none' && operatorAgent !== undefined && !ownerEmail)
    throw new RemoteRefusal(
      '--owner-email is required with --operator-agent on --auth none (the API-key deployment needs a human owner, as bootstrap does)',
    )

  if (auth === 'none' && str('org') !== undefined && operatorAgent === undefined)
    throw new RemoteRefusal(
      '--org only applies with --operator-agent on --auth none (without it only the deployment marker is written)',
    )

  const web = str('web-origin')
  const origins = [
    ...(web ? [validateOrigin('--web-origin', web)] : []),
    ...((values['extra-origin'] as string[] | undefined) ?? []).map((o) => validateOrigin('--extra-origin', o)),
  ]

  let only: StepName[] | undefined
  const onlyRaw = str('only')
  if (onlyRaw !== undefined) {
    only = onlyRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as StepName[]
    const unknown = only.filter((s) => !(STEP_NAMES as readonly string[]).includes(s))
    if (unknown.length > 0 || only.length === 0)
      throw new RemoteRefusal(
        `--only: unknown step ${unknown.join(', ') || '(none given)'}; steps are ${STEP_NAMES.join(', ')}`,
      )
    if (auth !== 'clerk' && only.some((s) => CLERK_ONLY_STEPS.includes(s)))
      throw new RemoteRefusal(
        `--only ${only.filter((s) => CLERK_ONLY_STEPS.includes(s)).join(', ')} needs --auth clerk`,
      )
  }

  // [[OPS262]] D5: a new instance's names are vb-<kind>-<env>; a recorded instance's names are applied by `applyRecordedNames`. Cloudflare's limit is 63.
  const nameFlags = {
    workerName: str('worker-name'),
    d1Name: str('d1-name'),
    controlD1Name: str('control-d1-name'),
    r2Name: str('r2-name'),
  }
  const opts: SetupOptions = {
    env,
    apiHost: apiHostFlag ?? '',
    workersDev,
    registerSubdomain,
    changeHost,
    ...(recordedHost ? { recordedHost } : {}),
    auth,
    org: str('org') ?? env,
    origins,
    operatorAgent,
    keyEnv,
    ownerEmail,
    workerName: nameFlags.workerName ?? `vb-${env}`,
    d1Name: nameFlags.d1Name ?? `vb-crm-${env}`,
    controlD1Name: nameFlags.controlD1Name ?? `vb-control-${env}`,
    r2Name: nameFlags.r2Name ?? `vb-bodies-${env}`,
    nameFlags,
    only,
    dryRun: values['dry-run'] === true,
    clerkEnvFile: str('clerk-env-file'),
    clerkPublishableKey: str('clerk-publishable-key'),
    clerkProduction: values['clerk-production'] === true,
    noDcr: values['no-dcr'] === true,
    rotateSecrets: values['rotate-secrets'] === true,
    ...(replaceValue !== undefined ? { replace: { old: {} } } : {}),
  }
  checkNameLengths([opts.workerName, opts.d1Name, opts.controlD1Name, opts.r2Name])
  checkDistinctDatabases(opts.d1Name, opts.controlD1Name)
  return opts
}

/** [[OPS262]] D5: Cloudflare names are at most 63 characters; a refusal before any step. */
export function checkNameLengths(names: string[]): void {
  for (const n of names)
    if (n.length > 63)
      throw new RemoteRefusal(
        `name ${n} is ${n.length} characters; Cloudflare allows at most 63 (use a shorter --env or give the name with a flag)`,
      )
}

/** [[OPS279]]: the control plane is its own database ([[CORE259]] D16), so its name differs from the CRM database's; a refusal before any step. */
export function checkDistinctDatabases(d1Name: string, controlD1Name: string): void {
  if (d1Name === controlD1Name)
    throw new RemoteRefusal(
      `control D1 name ${controlD1Name} equals the CRM database's name: the control plane is its own database (give --control-d1-name a different name)`,
    )
}
