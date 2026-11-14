// Test-only ([[CORE244]]): a local Ed25519 issuer shaped like Better Auth 1.7.22's tokens (claims read from real tokens minted in the server-d1 tests), so the adapter can be
// attacked with crafted ones. Never import from non-test code.
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'

export const BA_BASE = 'https://vibase.test'
export const BA_ISSUER = `${BA_BASE}/auth`

export interface BaIssuer {
  kid: string
  privateKey: CryptoKey
  /** The public JWK as `auth_jwks.public_key` stores it (JSON text). */
  publicJwk: string
}

export async function baIssuer(kid = 'key-1'): Promise<BaIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  return { kid, privateKey, publicJwk: JSON.stringify(await exportJWK(publicKey)) }
}

export interface BaMint {
  /** `session`: the JWT plugin's token with the vault's marker; `oauth`: an RFC 9068 access token; `id`: an OIDC ID token. Default `session`. */
  kind?: 'session' | 'oauth' | 'id'
  sub?: string
  clientId?: string
  scope?: string
  iss?: string
  aud?: string | string[]
  /** Seconds from `now`; default 900 (session) or 3600 (oauth, id). */
  ttl?: number
  now?: Date
  /** The signing algorithm: `EdDSA` (default), `none` (unsigned) or `HS256`. */
  alg?: 'EdDSA' | 'none' | 'HS256'
  key?: CryptoKey
  kid?: string | null
  extra?: Record<string, unknown>
  /** Drop a claim by name. */
  omit?: string[]
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export async function mintBaToken(issuer: BaIssuer, o: BaMint = {}): Promise<string> {
  const kind = o.kind ?? 'session'
  const now = Math.floor((o.now ?? new Date()).getTime() / 1000)
  const payload: Record<string, unknown> =
    kind === 'session'
      ? { vibase_token: 'session', sid: 'sess-1' }
      : kind === 'oauth'
        ? { client_id: o.clientId ?? 'client-a', azp: o.clientId ?? 'client-a', scope: o.scope ?? 'openid contacts:read', jti: 'jti-1' }
        : { acr: '0', at_hash: 'x', azp: o.clientId ?? 'client-a' }
  Object.assign(payload, o.extra)
  for (const name of o.omit ?? []) delete payload[name]
  const claims = { ...payload, sub: o.sub ?? 'subject-1', iat: now, exp: now + (o.ttl ?? (kind === 'session' ? 900 : 3600)), iss: o.iss ?? BA_ISSUER, aud: o.aud ?? (kind === 'id' ? (o.clientId ?? 'client-a') : BA_BASE) }
  const header = { alg: o.alg ?? 'EdDSA', ...(o.kid === null ? {} : { kid: o.kid ?? issuer.kid }), ...(kind === 'oauth' ? { typ: 'at+jwt' } : {}) }
  if (o.alg === 'none') return `${b64(header)}.${b64(claims)}.`
  const key = o.alg === 'HS256' ? new TextEncoder().encode('a-symmetric-secret-of-32-bytes!!!') : (o.key ?? issuer.privateKey)
  return new SignJWT(claims).setProtectedHeader(header).sign(key)
}
