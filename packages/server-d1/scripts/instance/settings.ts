// The instance settings file ([[OPS210]] D9, [[OPS231]]): public values only, validated with errors that name the key or the path.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTROL_PLACEHOLDER_DATABASE_ID, PLACEHOLDER_DATABASE_ID } from '../remote.js'
import { InstanceRefusal, type InstanceSettings } from './types.js'

/** The config root of the vibase CLI: `$XDG_CONFIG_HOME`, else `~/.config`. */
export const configRoot = (env: Record<string, string | undefined>, homedir: string): string => (env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir, '.config'))
export const instancesDir = (env: Record<string, string | undefined>, homedir: string): string => join(configRoot(env, homedir), 'vibase', 'instances')

export function defaultSettingsPath(env: Record<string, string | undefined>, homedir: string, envName: string): string {
  return join(instancesDir(env, homedir), `${envName}.json`)
}

const KEYS = ['version', 'env', 'worker', 'api_host', 'd1', 'control_d1', 'r2_bucket', 'workflow', 'vars', 'crons']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BARE_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseSettings(text: string, envName: string, path: string): InstanceSettings {
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
  for (const k of Object.keys(json)) if (!KEYS.includes(k)) fail(`unknown key "${k}"`)
  if (json.version !== 1) fail('version must be 1')
  if (json.env !== envName) fail(`env ${JSON.stringify(json.env)} does not match --env ${envName}`)
  const str = (v: unknown, key: string): string => (typeof v === 'string' && v !== '' ? v : fail(`${key} must be a non-empty string`))
  const worker = str(json.worker, 'worker')
  const api_host = str(json.api_host, 'api_host')
  if (!BARE_HOST.test(api_host)) fail('api_host must be a bare host such as api.example.com (no scheme, port or path)')
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
    if (control_d1.id === PLACEHOLDER_DATABASE_ID || control_d1.id === CONTROL_PLACEHOLDER_DATABASE_ID) fail('control_d1.id is a local placeholder: use the id of the real control database')
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
  // P2: a Better Auth Worker answers 500 on every non-health request without its control database ([[CORE259]] D6).
  if (vars.AUTH_PROVIDER === 'better-auth' && !control_d1) fail('vars.AUTH_PROVIDER is better-auth but control_d1 is missing: that instance needs its control database (name and id)')
  const out: InstanceSettings = { version: 1, env: envName, worker, api_host, d1, ...(control_d1 ? { control_d1 } : {}), r2_bucket, workflow, vars }
  if (json.crons !== undefined) {
    if (!Array.isArray(json.crons) || json.crons.some((c) => typeof c !== 'string' || c === '')) fail('crons must be a list of cron expressions')
    out.crons = json.crons as string[]
  }
  return out
}

export function loadSettings(path: string, envName: string): InstanceSettings {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new InstanceRefusal(`no settings file at ${path}: create it (vibase-server setup, or by hand) or pass --settings <path>`)
  }
  return parseSettings(text, envName, path)
}
