import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { usage } from './errors.js'
import type { Deps } from './types.js'

/** A connection by API key ([[API6]] D10). */
export interface ApiKeyProfile {
  kind: 'api_key'
  server: string
  api_key: string
}
/**
 * A connection by device login ([[API6]] D11). `expires_at` is epoch milliseconds. Empty tokens mean the grant was lost
 * (`invalid_grant`, or the issuer sent no refresh token): the profile keeps its server so the error can say what to run.
 */
export interface OAuthProfile {
  kind: 'oauth'
  server: string
  issuer: string
  client_id: string
  access_token: string
  refresh_token: string
  expires_at: number
  scope: string
}
export type Profile = ApiKeyProfile | OAuthProfile
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
    throw usage(`"${input}" is not a URL: --server takes an origin such as https://vibase.example.com`)
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw usage(`--server must be an https origin (http is allowed only for localhost and 127.0.0.1), got ${u.protocol}//${u.host}`)
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw usage('--server is an origin: no path, query or credentials (for example https://vibase.example.com)')
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
    if (!PROFILE_NAME.test(name) || typeof p !== 'object' || p === null || typeof p.server !== 'string') throw bad()
    if (p.kind === 'api_key' && typeof p.api_key === 'string') cfg.profiles[name] = { kind: 'api_key', server: p.server, api_key: p.api_key }
    else if (
      p.kind === 'oauth' &&
      ['issuer', 'client_id', 'access_token', 'refresh_token', 'scope'].every((k) => typeof p[k] === 'string') &&
      typeof p.expires_at === 'number' &&
      Number.isFinite(p.expires_at)
    ) {
      cfg.profiles[name] = { kind: 'oauth', server: p.server, issuer: p.issuer, client_id: p.client_id, access_token: p.access_token, refresh_token: p.refresh_token, expires_at: p.expires_at, scope: p.scope }
    } else throw bad()
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

/**
 * Settings precedence ([[API6]] D10): flags, then `VIBASE_SERVER` / `VIBASE_API_KEY` / `VIBASE_PROFILE`, then the profile.
 * A key stored in a profile belongs to that profile's server and is not used for another one.
 */
export function resolveConnection(
  cfg: Config,
  flags: { server?: string; profile?: string },
  env: Record<string, string | undefined>,
  opts: { needKey: boolean },
): { server: string; key?: string; profile: string; /** Set when the credential is the profile's OAuth grant: it is refreshed, and the key is its access token. */ oauth?: OAuthProfile } {
  const explicit = flags.profile ?? (env.VIBASE_PROFILE || undefined)
  const name = profileName(explicit ?? cfg.default_profile ?? 'default')
  const profile = Object.hasOwn(cfg.profiles, name) ? cfg.profiles[name] : undefined
  if (flags.profile !== undefined && !profile) throw usage(`no profile named "${name}" (vibase login --api-key --server <url> --profile ${name})`, 'no_profile')
  const rawServer = flags.server ?? (env.VIBASE_SERVER || undefined) ?? profile?.server
  if (!rawServer) throw usage('no server: pass --server, set VIBASE_SERVER, or run `vibase login --api-key --server <url>`', 'no_server')
  const server = serverOrigin(rawServer)
  let key = env.VIBASE_API_KEY || undefined
  let oauth: OAuthProfile | undefined
  if (!key && profile && serverOrigin(profile.server) === server) {
    if (profile.kind === 'api_key') key = profile.api_key
    else if (profile.access_token !== '') {
      oauth = profile
      key = profile.access_token
    }
  }
  if (opts.needKey && !key) throw usage(`no credential for ${server}: run \`vibase login --server ${server}\` (or \`--api-key\`), or set VIBASE_API_KEY`, 'no_credential')
  return { server, key, profile: name, oauth }
}
