// The instance settings file ([[OPS210]] D9, [[OPS231]]): public values only, validated with errors that name the key or the path.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { CONTROL_PLACEHOLDER_DATABASE_ID, PLACEHOLDER_DATABASE_ID } from '../remote.js'
import { apiHostProblem, authProblem, emailProblem } from '../setup/args.js'
import type { AuthProvider } from '../setup/better-auth.js'
import { isWorkersDevHost } from '../setup/host.js'
import { InstanceRefusal, type InitSettings, type InstanceSettings } from './types.js'

/** The config root of the vibase CLI: `$XDG_CONFIG_HOME`, else `~/.config`. */
export const configRoot = (env: Record<string, string | undefined>, homedir: string): string =>
  env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir, '.config')
export const instancesDir = (env: Record<string, string | undefined>, homedir: string): string =>
  join(configRoot(env, homedir), 'vibase', 'instances')

export function defaultSettingsPath(env: Record<string, string | undefined>, homedir: string, envName: string): string {
  return join(instancesDir(env, homedir), `${envName}.json`)
}

const KEYS = [
  'version',
  'env',
  'worker',
  'api_host',
  'workers_dev',
  'd1',
  'control_d1',
  'r2_bucket',
  'workflow',
  'vars',
  'crons',
  'stage',
  'auth',
  'owner_email',
  'schema',
]
/** The full record's closed key list: the keys before OPS501 plus `owner_email`; `stage` and `auth` belong to the init shape alone. */
const FULL_KEYS = KEYS.filter((k) => k !== 'stage' && k !== 'auth')
/** [[OPS501]] D1: the keys of the init-written shape; every other key belongs to the full record. */
const INIT_KEYS = ['version', 'env', 'stage', 'api_host', 'auth', 'owner_email']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BARE_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type ParsedSettings = { kind: 'full'; settings: InstanceSettings } | { kind: 'init'; init: InitSettings }

/** [[OPS501]] D5: what every command but `setup` and `init` says about a file that only records init's choices. */
export const notSetUpYet = (envName: string, path: string): string =>
  `${envName} is not set up yet (${path} was written by init): run vibase-server setup --env ${envName}`

/** The settings file in either shape: the full record (below), or the init-written one ([[OPS501]] D1). A mixture of the two is refused naming the key. */
export function parseAnySettings(
  text: string,
  envName: string,
  path: string,
  opts: { allowNoControl?: boolean } = {},
): ParsedSettings {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new InstanceRefusal(`${path}: not valid JSON`)
  }
  if (isObject(json) && json.stage !== undefined) return { kind: 'init', init: parseInit(json, envName, path) }
  return { kind: 'full', settings: parseFull(text, envName, path, opts) }
}

function parseInit(json: Record<string, unknown>, envName: string, path: string): InitSettings {
  const fail = (message: string): never => {
    throw new InstanceRefusal(`${path}: ${message}`)
  }
  for (const k of Object.keys(json)) if (!KEYS.includes(k)) fail(`unknown key "${k}"`)
  if (json.stage !== 'init') fail(`stage ${JSON.stringify(json.stage)} is not known (only "init")`)
  for (const k of Object.keys(json))
    if (!INIT_KEYS.includes(k))
      fail(`"${k}" is not allowed with stage "init" (an init-written file has only ${INIT_KEYS.join(', ')})`)
  if (json.version !== 1) fail('version must be 1')
  if (json.env !== envName) fail(`env ${JSON.stringify(json.env)} does not match --env ${envName}`)
  const api_host = typeof json.api_host === 'string' ? json.api_host : ''
  const hostProblem = apiHostProblem(api_host)
  if (hostProblem) fail(`api_host: ${hostProblem.replace(/^--api-host /, '')}`)
  const auth = typeof json.auth === 'string' ? json.auth : ''
  const authIssue = authProblem(auth)
  if (authIssue) fail(`auth: ${authIssue.replace(/^--auth /, '')}`)
  let owner_email: string | undefined
  if (json.owner_email !== undefined) {
    const e = typeof json.owner_email === 'string' ? json.owner_email : ''
    const problem = emailProblem(e, 'owner_email')
    if (problem) fail(problem)
    owner_email = e
  }
  return {
    version: 1,
    env: envName,
    stage: 'init',
    api_host,
    auth: auth as AuthProvider,
    ...(owner_email ? { owner_email } : {}),
  }
}

/**
 * [[CORE326]] P5: `control_d1` is required (every instance has a control-plane database). `vibase-server setup` is the one command that still loads settings without it (`allowNoControl`),
 * because it is what records the control database.
 */
export function parseSettings(
  text: string,
  envName: string,
  path: string,
  opts: { allowNoControl?: boolean } = {},
): InstanceSettings {
  const parsed = parseAnySettings(text, envName, path, opts)
  if (parsed.kind === 'init') throw new InstanceRefusal(notSetUpYet(envName, path))
  return parsed.settings
}

function parseFull(
  text: string,
  envName: string,
  path: string,
  opts: { allowNoControl?: boolean } = {},
): InstanceSettings {
  const fail = (message: string): never => {
    throw new InstanceRefusal(`${path}: ${message}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return fail('not valid JSON')
  }
  if (!isObject(json)) return fail('must be a JSON object')
  for (const k of Object.keys(json)) if (!FULL_KEYS.includes(k)) fail(`unknown key "${k}"`)
  if (json.version !== 1) fail('version must be 1')
  if (json.env !== envName) fail(`env ${JSON.stringify(json.env)} does not match --env ${envName}`)
  const str = (v: unknown, key: string): string =>
    typeof v === 'string' && v !== '' ? v : fail(`${key} must be a non-empty string`)
  const worker = str(json.worker, 'worker')
  const api_host = str(json.api_host, 'api_host')
  if (!BARE_HOST.test(api_host)) fail('api_host must be a bare host such as api.example.com (no scheme, port or path)')
  // [[OPS308]] D12: `workers_dev` is a flag, absent meaning false (a custom-domain record stays as it was); a host under workers.dev needs it on.
  if (json.workers_dev !== undefined && typeof json.workers_dev !== 'boolean') fail('workers_dev must be true or false')
  const workers_dev = json.workers_dev === true
  if (isWorkersDevHost(api_host) && !workers_dev) fail('api_host is a workers.dev host but workers_dev is not true')
  const r2_bucket = str(json.r2_bucket, 'r2_bucket')
  if (!isObject(json.d1)) return fail('d1 must be an object with name and id')
  for (const k of Object.keys(json.d1)) if (k !== 'name' && k !== 'id') fail(`unknown key "d1.${k}"`)
  const d1 = { name: str(json.d1.name, 'd1.name'), id: str(json.d1.id, 'd1.id') }
  if (d1.id === PLACEHOLDER_DATABASE_ID) fail('d1.id is the local placeholder: use the id of the real database')
  if (!UUID.test(d1.id)) fail('d1.id must be a UUID')
  let control_d1: { name: string; id: string } | undefined
  if (json.control_d1 !== undefined) {
    if (!isObject(json.control_d1)) return fail('control_d1 must be an object with name and id')
    for (const k of Object.keys(json.control_d1)) if (k !== 'name' && k !== 'id') fail(`unknown key "control_d1.${k}"`)
    control_d1 = { name: str(json.control_d1.name, 'control_d1.name'), id: str(json.control_d1.id, 'control_d1.id') }
    if (control_d1.id === PLACEHOLDER_DATABASE_ID || control_d1.id === CONTROL_PLACEHOLDER_DATABASE_ID)
      fail('control_d1.id is a local placeholder: use the id of the real control database')
    if (!UUID.test(control_d1.id)) fail('control_d1.id must be a UUID')
    if (control_d1.id === d1.id) fail('control_d1.id equals d1.id: the control plane is its own database')
    if (control_d1.name === d1.name) fail('control_d1.name equals d1.name: the control plane is its own database')
  }
  if (!isObject(json.workflow)) return fail('workflow must be an object with name')
  for (const k of Object.keys(json.workflow)) if (k !== 'name') fail(`unknown key "workflow.${k}"`)
  const workflow = { name: str(json.workflow.name, 'workflow.name') }
  if (!isObject(json.vars)) return fail('vars must be an object of strings')
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(json.vars)) {
    if (typeof v !== 'string') fail(`vars.${k} must be a string`)
    vars[k] = v as string
  }
  // [[CORE326]] P5 (the general case of [[OPS275]] P2): a Worker answers 500 on every non-health request without its control database, in every auth mode ([[CORE259]] D6).
  if (!control_d1 && !opts.allowNoControl)
    fail(
      `control_d1 is missing: every instance needs its control-plane database (name and id); run vibase-server setup --env ${envName} to add it`,
    )
  const out: InstanceSettings = {
    version: 1,
    env: envName,
    worker,
    api_host,
    ...(workers_dev ? { workers_dev } : {}),
    d1,
    ...(control_d1 ? { control_d1 } : {}),
    r2_bucket,
    workflow,
    vars,
  }
  if (json.crons !== undefined) {
    if (!Array.isArray(json.crons) || json.crons.some((c) => typeof c !== 'string' || c === ''))
      fail('crons must be a list of cron expressions')
    out.crons = json.crons as string[]
  }
  if (json.owner_email !== undefined) {
    const problem =
      typeof json.owner_email === 'string'
        ? emailProblem(json.owner_email, 'owner_email')
        : 'owner_email must be a string'
    if (problem) fail(problem)
    out.owner_email = json.owner_email as string
  }
  // [[CORE543]] P3: the absolute path `redeploy --schema` recorded; a later `redeploy` or `upgrade` attaches that file.
  if (json.schema !== undefined) {
    if (typeof json.schema !== 'string' || !isAbsolute(json.schema))
      fail('schema must be the absolute path of a schema file')
    out.schema = json.schema as string
  }
  return out
}

export function loadSettings(path: string, envName: string, opts: { allowNoControl?: boolean } = {}): InstanceSettings {
  const parsed = loadAnySettings(path, envName, opts)
  if (parsed.kind === 'init') throw new InstanceRefusal(notSetUpYet(envName, path))
  return parsed.settings
}

/** `loadSettings` for the two commands that know the init-written shape: `setup` and `init`. */
export function loadAnySettings(
  path: string,
  envName: string,
  opts: { allowNoControl?: boolean } = {},
): ParsedSettings {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new InstanceRefusal(
      `no settings file at ${path}: create it (vibase-server setup, or by hand) or pass --settings <path>`,
    )
  }
  return parseAnySettings(text, envName, path, opts)
}

/** [[OPS501]] D2: the init file's text, pretty JSON; `owner_email` absent when init had none. */
export const initSettingsText = (i: Omit<InitSettings, 'version' | 'stage'>): string =>
  `${JSON.stringify(
    {
      version: 1,
      env: i.env,
      stage: 'init',
      api_host: i.api_host,
      auth: i.auth,
      ...(i.owner_email ? { owner_email: i.owner_email } : {}),
    },
    null,
    2,
  )}\n`

/** Replaces the file atomically: a temp file in the same directory, then a rename, so a failed write never leaves half a file. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** [[CORE543]] P3: records the schema file's absolute path in an existing settings file (an atomic replace), changing no other key. */
export function recordSchemaFile(settingsPath: string, schemaPath: string): void {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new InstanceRefusal(`${settingsPath}: cannot read it to record the schema path`)
  }
  if (json.schema === schemaPath) return
  writeFileAtomic(settingsPath, `${JSON.stringify({ ...json, schema: schemaPath }, null, 2)}\n`)
}
