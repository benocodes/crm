// Google's OAuth 2.0 web-server flow, the vault's side ([[CHN5]] D1, D9): the authorize URL, the code exchange and the ID token check.
// Every call goes through an injected `fetch`, and the endpoints are injectable, so no test reaches Google. A failure is a
// `GoogleExchangeError` carrying a short code only: never the response body, the URL, a token or the client secret.
import { createLocalJWKSet, jwtVerify } from 'jose'

export interface GoogleEndpoints {
  authorizeUrl: string
  tokenUrl: string
  /** Google's signing keys (JWKS) for ID tokens. */
  jwksUrl: string
}
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
}
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send'
/**
 * The scopes requested (user decision 2026-11-05, replacing D2's readonly-only): read and send, so one consent covers both. Nothing in the vault calls send
 * yet and agents never send (invariant 4). `gmail.readonly` is required (its absence is `scope_missing`); `gmail.send` is recorded if granted. `sendAs.list` is covered by readonly (D10).
 */
export const REQUESTED_SCOPES: readonly string[] = ['openid', 'email', GMAIL_READONLY, GMAIL_SEND]
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** `access_type=offline` and `prompt=consent` are what make Google return a refresh token on a reconnect too (D1). */
export function buildAuthorizeUrl(p: { endpoints: GoogleEndpoints; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(p.endpoints.authorizeUrl)
  const q = url.searchParams
  q.set('client_id', p.clientId)
  q.set('redirect_uri', p.redirectUri)
  q.set('response_type', 'code')
  q.set('scope', REQUESTED_SCOPES.join(' '))
  q.set('access_type', 'offline')
  q.set('prompt', 'consent')
  q.set('include_granted_scopes', 'true')
  q.set('state', p.state)
  q.set('code_challenge', p.challenge)
  q.set('code_challenge_method', 'S256')
  return url.toString()
}

export class GoogleExchangeError extends Error {
  override name = 'GoogleExchangeError'
  constructor(readonly code: 'token_endpoint' | 'bad_response' | 'no_refresh_token' | 'id_token') {
    super(`Google exchange failed: ${code}`)
  }
}

/** The authorization-code exchange. The client secret and the PKCE verifier travel in the POST body, never in a URL. */
export async function exchangeCode(p: {
  endpoints: GoogleEndpoints
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  verifier: string
  fetch: typeof fetch
}): Promise<{ refreshToken: string; accessToken: string; idToken: string; scopes: string[] }> {
  let res: Response
  try {
    res = await p.fetch(p.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code_verifier: p.verifier }).toString(),
    })
  } catch {
    throw new GoogleExchangeError('token_endpoint')
  }
  if (!res.ok) throw new GoogleExchangeError('token_endpoint')
  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new GoogleExchangeError('bad_response')
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const accessToken = str(body.access_token)
  const idToken = str(body.id_token)
  if (!accessToken || !idToken) throw new GoogleExchangeError('bad_response')
  const refreshToken = str(body.refresh_token)
  if (!refreshToken) throw new GoogleExchangeError('no_refresh_token')
  return { refreshToken, accessToken, idToken, scopes: (str(body.scope) ?? '').split(' ').filter(Boolean) }
}

/**
 * Verifies the ID token against Google's keys: signature, `iss`, `aud` = the client id, expiry, and `email_verified` ([[CHN5]] D9). The keys
 * are fetched per call (a connect is rare) through the injected `fetch`. Returns the stable `sub` and the email.
 */
export async function verifyIdToken(idToken: string, p: { endpoints: GoogleEndpoints; clientId: string; fetch: typeof fetch; nowMs: number }): Promise<{ sub: string; email: string }> {
  try {
    const res = await p.fetch(p.endpoints.jwksUrl)
    if (!res.ok) throw new Error('jwks')
    const jwks = createLocalJWKSet((await res.json()) as Parameters<typeof createLocalJWKSet>[0])
    const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUERS, audience: p.clientId, currentDate: new Date(p.nowMs), algorithms: ['RS256'] })
    if (payload.email_verified !== true || typeof payload.email !== 'string' || payload.email === '' || typeof payload.sub !== 'string' || payload.sub === '') throw new Error('claims')
    return { sub: payload.sub, email: payload.email }
  } catch {
    throw new GoogleExchangeError('id_token')
  }
}

/** What a refresh answers: a fresh access token, and a NEW refresh token only when Google rotated it. */
export interface RefreshedToken {
  accessToken: string
  refreshToken: string | null
}
/** A refresh that failed, as a short code only (never the body, the URL or a token). `invalid_grant` is Google's verdict on the grant itself ([[CHN5]] D68). */
export class GoogleRefreshError extends Error {
  override name = 'GoogleRefreshError'
  constructor(readonly code: 'invalid_grant' | 'oauth_error' | 'token_endpoint' | 'bad_response') {
    super(`Google refresh failed: ${code}`)
  }
}
/**
 * The refresh-token grant ([[CHN5]] D68): one POST of `grant_type=refresh_token`, the refresh token, client id and secret, as a form. A 400 whose
 * `error` is `invalid_grant` is Google's verdict on the grant. Every other failure (another OAuth error, a non-2xx, a network error) is a different
 * code. Nothing returned or thrown carries a response body, the URL, a token or the secret.
 */
export async function refreshAccessToken(p: { endpoints: GoogleEndpoints; clientId: string; clientSecret: string; refreshToken: string; fetch: typeof fetch }): Promise<RefreshedToken> {
  let res: Response
  try {
    res = await p.fetch(p.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret }).toString(),
    })
  } catch {
    throw new GoogleRefreshError('token_endpoint')
  }
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // not JSON: classified by status below
  }
  if (!res.ok) {
    if (res.status === 400 && body.error === 'invalid_grant') throw new GoogleRefreshError('invalid_grant')
    if (res.status < 500 && typeof body.error === 'string') throw new GoogleRefreshError('oauth_error')
    throw new GoogleRefreshError('token_endpoint')
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const accessToken = str(body.access_token)
  if (!accessToken) throw new GoogleRefreshError('bad_response')
  return { accessToken, refreshToken: str(body.refresh_token) }
}
