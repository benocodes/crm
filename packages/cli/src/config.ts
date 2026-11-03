import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { usage } from './errors.js'
import type { Deps } from './types.js'

/** One named connection. Only API keys exist in this release; `kind` leaves room for OAuth ([[API6]] D11). */
export interface Profile {
  kind: 'api_key'
  server: string
  api_key: string
}
export interface Config {
  version: 1
  default_profile?: string
  profiles: Record<string, Profile>
}

export const configPath = (deps: Deps) => join(deps.env.XDG_CONFIG_HOME || join(deps.homedir, '.config'), 'vibase', 'config.json')
export const cacheDirPath = (deps: Deps) => join(deps.env.XDG_CACHE_HOME || join(deps.homedir, '.cache'), 'vibase')

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export function profileName(name: string): string {
  if (!PROFILE_NAME.test(name)) throw usage(`"${name}" is not a valid profile name (letters, digits, ".", "_", "-")`)
  return name
}

/**
 * `--server` is an origin ([[API6]] D18): `https`, or `http` only for `localhost` and `127.0.0.1`; no path, query or userinfo.
 * Returns the normalised origin.
 */
export function serverOrigin(input: string): string {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    throw usage(`"${input}" is not a URL: --server takes an origin such as https://vault.example.com`)
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw usage(`--server must be an https origin (http is allowed only for localhost and 127.0.0.1), got ${u.protocol}//${u.host}`)
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw usage('--server is an origin: no path, query or credentials (for example https://vault.example.com)')
  return u.origin
}

const empty = (): Config => ({ version: 1, profiles: {} })

/** Reads the config. Absent: empty. Refused (exit 2) when group- or world-readable, or malformed. Contents are never echoed. */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) return empty()
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) throw usage(`${path} has permissions ${mode.toString(8).padStart(4, '0')}: it holds credentials and must be mode 0600 (chmod 600 ${path})`, 'config_permissions')
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw usage(`${path} is not valid JSON`, 'config_invalid')
  }
  const bad = () => usage(`${path} does not have the expected shape ({ version: 1, default_profile?, profiles })`, 'config_invalid')
  if (typeof raw !== 'object' || raw === null || raw.version !== 1 || typeof raw.profiles !== 'object' || raw.profiles === null || Array.isArray(raw.profiles)) throw bad()
  const cfg: Config = { version: 1, profiles: {} }
  if (raw.default_profile !== undefined) {
    if (typeof raw.default_profile !== 'string') throw bad()
    cfg.default_profile = raw.default_profile
  }
  for (const [name, p] of Object.entries<any>(raw.profiles)) {
    if (!PROFILE_NAME.test(name) || typeof p !== 'object' || p === null || p.kind !== 'api_key' || typeof p.server !== 'string' || typeof p.api_key !== 'string') throw bad()
    cfg.profiles[name] = { kind: 'api_key', server: p.server, api_key: p.api_key }
  }
  return cfg
}

/** Writes the config as mode 0600 by temp file and rename, so a reader never sees half a file. */
export function saveConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify(cfg, null, 2) + '\n')
    closeSync(fd)
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
    throw e
  }
}

export interface Connection {
  server: string
  key: string
  profile: string
}

/**
 * Settings precedence ([[API6]] D10): flags, then `VIBASE_SERVER` / `VIBASE_API_KEY` / `VIBASE_PROFILE`, then the profile.
 * A key stored in a profile belongs to that profile's server and is not used for another one.
 */
export function resolveConnection(
  cfg: Config,
  flags: { server?: string; profile?: string },
  env: Record<string, string | undefined>,
  opts: { needKey: boolean },
): { server: string; key?: string; profile: string } {
  const explicit = flags.profile ?? (env.VIBASE_PROFILE || undefined)
  const name = profileName(explicit ?? cfg.default_profile ?? 'default')
  const profile = Object.hasOwn(cfg.profiles, name) ? cfg.profiles[name] : undefined
  if (flags.profile !== undefined && !profile) throw usage(`no profile named "${name}" (vibase login --api-key --server <url> --profile ${name})`, 'no_profile')
  const rawServer = flags.server ?? (env.VIBASE_SERVER || undefined) ?? profile?.server
  if (!rawServer) throw usage('no server: pass --server, set VIBASE_SERVER, or run `vibase login --api-key --server <url>`', 'no_server')
  const server = serverOrigin(rawServer)
  let key = env.VIBASE_API_KEY || undefined
  if (!key && profile && serverOrigin(profile.server) === server) key = profile.api_key
  if (opts.needKey && !key) throw usage(`no credential for ${server}: run \`vibase login --api-key --server ${server}\` or set VIBASE_API_KEY`, 'no_credential')
  return { server, key, profile: name }
}
