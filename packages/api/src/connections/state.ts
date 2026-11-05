// The OAuth state and the PKCE verifier ([[CHN5]] D57). The state is stateless: `base64url(JSON claims) + "." + base64url(HMAC-SHA256)`, so
// a store would be the only reason for a table. The PKCE verifier is derived from the secret and the state's nonce, so nothing secret sits in
// the browser and nothing is stored. Everything is Web Crypto; the comparison of signatures is `crypto.subtle.verify` (constant time).
import { base64UrlDecode, base64UrlEncode } from './base64url.js'

export interface StateClaims {
  user_id: string
  nonce: string
  /** Epoch milliseconds. */
  expires_at: number
}

const enc = new TextEncoder()
const hmacKey = (secret: string, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

export async function signState(secret: string, claims: StateClaims): Promise<string> {
  const payload = base64UrlEncode(enc.encode(JSON.stringify(claims)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(payload)))
  return `${payload}.${base64UrlEncode(sig)}`
}

/** The claims of a state this secret signed that has not expired; null for anything else (malformed, forged, expired, wrong shape). */
export async function verifyState(secret: string, state: string, nowMs: number): Promise<StateClaims | null> {
  const parts = state.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts as [string, string]
  const sigBytes = base64UrlDecode(sig)
  const payloadBytes = base64UrlDecode(payload)
  // Canonical encodings only: a flipped padding bit decodes to the same bytes and must not pass for a different text.
  if (!sigBytes || !payloadBytes || sigBytes.length === 0 || base64UrlEncode(sigBytes) !== sig || base64UrlEncode(payloadBytes) !== payload) return null
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sigBytes as BufferSource, enc.encode(payload)))) return null
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
  const c = claims as Partial<StateClaims> | null
  if (!c || typeof c.user_id !== 'string' || typeof c.nonce !== 'string' || typeof c.expires_at !== 'number' || !Number.isFinite(c.expires_at)) return null
  if (nowMs >= c.expires_at) return null
  return { user_id: c.user_id, nonce: c.nonce, expires_at: c.expires_at }
}

/** `base64url(HMAC-SHA256(secret, "pkce:" || nonce))`: 43 unreserved characters, a valid RFC 7636 verifier. */
export async function pkceVerifier(secret: string, nonce: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`pkce:${nonce}`))))
}

/** The S256 challenge: `base64url(SHA-256(verifier))`. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))))
}
