import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { configPath, loadConfig, saveConfig, type OAuthProfile } from './config.js'
import { CliError, usage } from './errors.js'
import type { Deps } from './types.js'

// Device login, refresh, the refresh lock and revocation ([[API6]] D11, D18-D21; RFC 8414, 8628, 6749, 7009). Credentials go
// only where D18 says: the access token to the instance (http.ts), the refresh token to the token and revocation endpoints.
// Every request here uses `redirect: 'error'`: a redirect is never followed, so no body or header can be steered off-origin.

export const REFRESH_WINDOW_MS = 60_000
export const LOCK_WAIT_MS = 10_000
export const LOCK_STALE_MS = 30_000
const LOCK_POLL_MS = 100
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
const network = (url: string, e: unknown) => new CliError(1, 'network_error', `could not reach ${url}: ${e instanceof Error ? e.message : 'request failed'}`)

/** GET JSON from a metadata document. Never carries a credential. */
export async function getJson(url: string, deps: Deps): Promise<{ status: number; body: any }> {
  let res: Response
  try {
    res = await deps.fetch(url, { headers: { accept: 'application/json', 'user-agent': `vibase-cli/${deps.version}` }, redirect: 'error' })
  } catch (e) {
    throw network(url, e)
  }
  return { status: res.status, body: await res.json().catch(() => undefined) }
}

/** POST a form to an issuer endpoint. The answer is returned whatever its status: OAuth errors are 400s with a JSON body. */
async function postForm(url: string, params: Record<string, string>, deps: Deps): Promise<{ ok: boolean; status: number; body: any }> {
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': `vibase-cli/${deps.version}` },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
    })
  } catch (e) {
    throw network(url, e)
  }
  const text = await res.text().catch(() => '')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON
  }
  return { ok: res.ok, status: res.status, body }
}

/** The OAuth error of an answer as a CliError (exit 1). Provider text only: never the request. */
function oauthError(res: { status: number; body: any }): CliError {
  const code = typeof res.body?.error === 'string' ? res.body.error : res.body === undefined ? 'invalid_response' : `http_${res.status}`
  const desc = typeof res.body?.error_description === 'string' ? `: ${res.body.error_description}` : ''
  return new CliError(1, code, res.body === undefined ? `the authorization server answered ${res.status} with something that is not JSON` : `the authorization server refused (${code})${desc}`)
}

export interface AuthServer {
  issuer: string
  device_authorization_endpoint?: string
  token_endpoint: string
  revocation_endpoint?: string
}

/** An endpoint must be `https` on the issuer's origin (decision, stricter than D18). */
function endpoint(issuerOrigin: string, name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  let u: URL | undefined
  try {
    u = typeof value === 'string' ? new URL(value) : undefined
  } catch {
    // not a URL
  }
  if (!u || u.protocol !== 'https:' || u.origin !== issuerOrigin) throw usage(`the authorization server's ${name} (${String(value).slice(0, 200)}) is not an https URL on the issuer's origin ${issuerOrigin}: refusing to continue`, 'endpoint_origin')
  return u.href
}

/** The issuer must be an `https` URL (D18). Returns its origin. */
export function issuerOrigin(issuer: unknown): string {
  let u: URL | undefined
  try {
    u = typeof issuer === 'string' ? new URL(issuer) : undefined
  } catch {
    // not a URL
  }
  if (!u || u.protocol !== 'https:') throw usage(`the issuer ${String(issuer).slice(0, 200)} is not an https URL: refusing to continue`, 'insecure_issuer')
  return u.origin
}

/**
 * RFC 8414 metadata of `issuer` ([[CORE283]] D12). A root issuer has one document URL. A path issuer (`https://h/auth`) is fetched by path insertion first
 * (`https://h/.well-known/oauth-authorization-server/auth`, RFC 8414 section 3.1) and by the appended form (`https://h/auth/.well-known/...`) only when the
 * first answers a non-200. A 200 is final: its `issuer` must equal the one asked for, and a mismatch is refused, never retried at the other URL. Every endpoint
 * is checked before anything is sent to one.
 */
export async function fetchAuthServer(issuer: string, deps: Deps): Promise<AuthServer> {
  const origin = issuerOrigin(issuer)
  const path = new URL(issuer).pathname.replace(/\/+$/, '')
  const base = issuer.replace(/\/+$/, '')
  const candidates = path === '' ? [`${base}/.well-known/oauth-authorization-server`] : [`${origin}/.well-known/oauth-authorization-server${path}`, `${base}/.well-known/oauth-authorization-server`]
  let url = candidates[0]!
  let answer: { status: number; body: any } = { status: 0, body: undefined }
  for (const candidate of candidates) {
    url = candidate
    answer = await getJson(candidate, deps)
    if (answer.status === 200) break
  }
  const { status, body } = answer
  if (status !== 200 || typeof body !== 'object' || body === null) throw usage(`${candidates.join(' and ')} answered ${status}: the issuer does not publish RFC 8414 metadata`, 'discovery_failed')
  if (body.issuer !== issuer) throw usage(`${url} names the issuer ${String(body.issuer).slice(0, 200)}, not ${issuer}: refusing to continue`, 'issuer_mismatch')
  const token_endpoint = endpoint(origin, 'token_endpoint', body.token_endpoint)
  const device = endpoint(origin, 'device_authorization_endpoint', body.device_authorization_endpoint)
  const revocation = endpoint(origin, 'revocation_endpoint', body.revocation_endpoint)
  if (!token_endpoint) throw usage(`${url} has no token_endpoint`, 'discovery_failed')
  return { issuer, token_endpoint, ...(device ? { device_authorization_endpoint: device } : {}), ...(revocation ? { revocation_endpoint: revocation } : {}) }
}

const humanDuration = (seconds: number) => (seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`)

export interface LoginGrant {
  access_token: string
  refresh_token: string
  expires_at: number
  scope: string
}

/** The device grant (steps 3 to 5 of D11): request, prompt on stderr, poll. Throws exit 1 on denial and expiry. */
export async function deviceGrant(as: AuthServer, clientId: string, scope: string, deps: Deps, resource?: string): Promise<LoginGrant> {
  if (!as.device_authorization_endpoint) throw usage('the issuer publishes no device_authorization_endpoint: it does not support device login', 'discovery_failed')
  const dev = await postForm(as.device_authorization_endpoint, { client_id: clientId, scope, ...(resource ? { resource } : {}) }, deps)
  if (!dev.ok) throw oauthError(dev)
  const b = dev.body
  if (!str(b?.device_code) || !str(b?.user_code) || !str(b?.verification_uri)) throw new CliError(1, 'invalid_response', 'the device authorization response is missing device_code, user_code or verification_uri')
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 600
  let interval = typeof b.interval === 'number' && b.interval > 0 ? b.interval : 5
  const deadline = deps.now() + expiresIn * 1000
  const where = str(b.verification_uri_complete) ? `open ${b.verification_uri_complete}` : `open ${b.verification_uri} and enter the code ${b.user_code}`
  await deps.stderr.write(`To sign in, ${where}\nThe code expires in ${humanDuration(expiresIn)}. Waiting for approval...\n`)

  for (;;) {
    await deps.sleep(interval * 1000)
    if (deps.now() > deadline) throw new CliError(1, 'expired_token', 'the sign-in code expired before it was approved: run `vibase login` again')
    const res = await postForm(as.token_endpoint, { grant_type: DEVICE_GRANT, device_code: b.device_code, client_id: clientId, ...(resource ? { resource } : {}) }, deps)
    if (res.ok) return grantFrom(res.body, scope, deps)
    switch (res.body?.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        interval += 5
        continue
      case 'access_denied':
        throw new CliError(1, 'access_denied', 'the sign-in was denied')
      case 'expired_token':
        throw new CliError(1, 'expired_token', 'the sign-in code expired before it was approved: run `vibase login` again')
      default:
        throw oauthError(res)
    }
  }
}

function grantFrom(body: any, requested: string, deps: Deps): LoginGrant {
  if (!str(body?.access_token)) throw new CliError(1, 'invalid_response', 'the token response has no access_token')
  const life = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : '',
    expires_at: deps.now() + life * 1000,
    scope: typeof body.scope === 'string' ? body.scope : requested,
  }
}

// ---- the lock -------------------------------------------------------------------------------------------------------

/** The lock file's mtime, or now when it vanished meanwhile (then it is not stale and the loop retries). */
const mtimeOrNow = (path: string) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return Date.now()
  }
}

export const lockPath = (deps: Deps) => `${configPath(deps)}.lock`

/**
 * Runs `fn` holding the exclusive lock file beside the config (`O_EXCL`; waits up to 10 s; a lock older than 30 s is stale and
 * taken over). The lock's content is its owner's id and the time it was taken (the CLI's clock), so a crashed process's lock ages out.
 */
export async function withLock<T>(deps: Deps, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(deps)
  const id = randomBytes(8).toString('hex')
  const started = deps.now()
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ id, at: deps.now() }))
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw usage(`cannot take the lock ${path}: ${e instanceof Error ? e.message : 'error'}`)
    }
    let seen: string | undefined
    try {
      seen = readFileSync(path, 'utf8')
    } catch {
      continue // released while we looked
    }
    let at: number | undefined
    try {
      at = JSON.parse(seen).at
    } catch {
      // being written: judged by the file's own age below
    }
    const stale = typeof at === 'number' ? deps.now() - at > LOCK_STALE_MS : Date.now() - mtimeOrNow(path) > LOCK_STALE_MS
    if (stale) {
      // Remove it only if it is still the lock we judged.
      try {
        if (readFileSync(path, 'utf8') === seen) unlinkSync(path)
      } catch {
        // gone already
      }
      continue
    }
    if (deps.now() - started >= LOCK_WAIT_MS) throw new CliError(1, 'lock_timeout', `another vibase process has held ${path} for more than ${LOCK_WAIT_MS / 1000} s: try again, or remove it if no vibase is running`)
    await deps.sleep(LOCK_POLL_MS)
  }
  try {
    return await fn()
  } finally {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).id === id) unlinkSync(path)
    } catch {
      // not ours any more, or gone
    }
  }
}

// ---- refresh --------------------------------------------------------------------------------------------------------

const loginAgain = (name: string, server: string) => `run \`vibase login --server ${server}${name === 'default' ? '' : ` --profile ${name}`}\``

/**
 * The profile with a usable access token (D20). `expiring`: refresh when it is within 60 s of expiry; `rejected`: the server
 * answered 401 to `stale`, so refresh unless another process already replaced it. Under the lock the profile is re-read, and
 * a refresh another process finished is adopted instead of repeated.
 */
export async function refreshProfile(deps: Deps, name: string, why: { kind: 'expiring' } | { kind: 'rejected'; stale: string }): Promise<OAuthProfile> {
  const path = configPath(deps)
  return withLock(deps, async () => {
    const cfg = loadConfig(path)
    const p = Object.hasOwn(cfg.profiles, name) ? cfg.profiles[name] : undefined
    if (!p || p.kind !== 'oauth') throw usage(`profile "${name}" is not signed in by device login`, 'no_credential')
    if (why.kind === 'expiring' && p.expires_at - deps.now() > REFRESH_WINDOW_MS) return p
    if (why.kind === 'rejected' && p.access_token !== why.stale) return p
    if (p.refresh_token === '') throw new CliError(1, 'login_required', `this profile has no refresh token: ${loginAgain(name, p.server)}`)
    const as = await fetchAuthServer(p.issuer, deps)
    const res = await postForm(as.token_endpoint, { grant_type: 'refresh_token', refresh_token: p.refresh_token, client_id: p.client_id, ...(p.resource ? { resource: p.resource } : {}) }, deps)
    if (res.ok) {
      const g = grantFrom(res.body, p.scope, deps)
      // A rotating issuer sends a new refresh token; one that does not keeps the old one valid.
      const next: OAuthProfile = { ...p, access_token: g.access_token, refresh_token: g.refresh_token || p.refresh_token, expires_at: g.expires_at, scope: g.scope }
      cfg.profiles[name] = next
      saveConfig(path, cfg)
      return next
    }
    if (res.body?.error === 'invalid_grant') {
      cfg.profiles[name] = { ...p, access_token: '', refresh_token: '', expires_at: 0 }
      saveConfig(path, cfg)
      throw new CliError(1, 'invalid_grant', `the grant is no longer valid (revoked or expired): ${loginAgain(name, p.server)}`)
    }
    throw oauthError(res)
  })
}

/** The profile as it stands if its token is good for more than 60 s, else refreshed (no lock is taken for the common case). */
export async function ensureFresh(deps: Deps, name: string, p: OAuthProfile): Promise<OAuthProfile> {
  return p.expires_at - deps.now() > REFRESH_WINDOW_MS ? p : refreshProfile(deps, name, { kind: 'expiring' })
}

// ---- revocation -----------------------------------------------------------------------------------------------------

/** RFC 7009: revoke the refresh token. Throws exit 1 on any failure; the caller still removes the profile. */
export async function revokeRefreshToken(p: OAuthProfile, deps: Deps): Promise<'revoked' | 'unsupported'> {
  const as = await fetchAuthServer(p.issuer, deps)
  if (!as.revocation_endpoint) return 'unsupported'
  const res = await postForm(as.revocation_endpoint, { token: p.refresh_token, token_type_hint: 'refresh_token', client_id: p.client_id }, deps)
  if (!res.ok) throw new CliError(1, 'revocation_failed', `the authorization server did not revoke the grant (${res.status}): it may still be live until it expires`)
  return 'revoked'
}
