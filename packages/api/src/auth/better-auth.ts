import { decodeProtectedHeader, errors, importJWK, jwtVerify, type CryptoKey } from 'jose'
import { ProfileNotFoundError } from './adapter.js'
import type { AuthAdapter, AuthProfile, VerifyFailure, VerifyResult } from './adapter.js'

/**
 * The built-in provider's token adapter ([[CORE244]] D8, D9, D23): a Bearer JWT minted by the Worker's own Better Auth, verified in-process against the provider's public signing keys. The
 * reads (keys, profile, client name) are injected: composition supplies them from the control store, so this module never names the control-plane database ([[CORE259]] D5).
 */
export interface BetterAuthKey {
  /** The `kid` header Better Auth puts in a token: the key row id. */
  kid: string
  /** The key's algorithm; Better Auth's default is `EdDSA`. */
  alg: string
  /** The public key as a JWK, JSON text. */
  publicJwk: string
}
export interface BetterAuthAdapterConfig {
  /** `<PUBLIC_BASE_URL>/auth`: configuration only, never the request's host (D23). */
  issuer: string
  /**
   * The API origin (`PUBLIC_BASE_URL`): the audience of a session JWT and the resource of an access token. A list ([[CORE283]] P1) accepts a token whose `aud` includes any of them:
   * the API origin and the MCP endpoint's URI name the same Worker and the same scope check on every surface.
   */
  audience: string | readonly string[]
  /** One read of every public signing key; called at most as often as the cache allows. */
  readKeys(): Promise<BetterAuthKey[]>
  readProfile(subject: string): Promise<{ email: string | null; emailVerified: boolean; name: string | null } | null>
  readClientName(clientId: string): Promise<string | null>
  now?: () => Date
}

/** Mirrors `@vibase/auth`'s `SESSION_TOKEN_CLAIM` and `SESSION_TOKEN_VALUE` (the Worker's composition test holds the two equal): `@vibase/api` does not depend on the provider package. */
export const SESSION_TOKEN_CLAIM = 'vibase_token'
export const SESSION_TOKEN_VALUE = 'session'

/** How long the keys are kept per isolate, and the least time between two reads caused by a `kid` the cache does not know ([[CORE244]] P1). */
export const JWKS_CACHE_MS = 5 * 60_000
export const JWKS_UNKNOWN_KID_REREAD_MS = 30_000

/** Asymmetric algorithms only; the stored key's own algorithm must match the header's. */
const ALGORITHMS: ReadonlySet<string> = new Set(['EdDSA', 'ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'])
/** RFC 9068's `typ` header values for a JWT access token; Better Auth's OAuth provider sets `at+jwt`. */
const ACCESS_TOKEN_TYPES: ReadonlySet<string> = new Set(['at+jwt', 'application/at+jwt'])
/** The provider's own OIDC scopes say nothing about the vault and are dropped from every token ([[CORE77]] D18). */
const PROVIDER_OWN_SCOPES: ReadonlySet<string> = new Set(['openid', 'profile', 'email', 'offline_access'])

type Cached = { alg: string; key: CryptoKey | Uint8Array }

function failureReason(err: unknown): VerifyFailure {
  if (err instanceof errors.JWTExpired) return 'expired'
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === 'nbf') return 'not_yet_valid'
    if (err.claim === 'iss') return 'issuer'
    return 'claims'
  }
  if (err instanceof errors.JWSSignatureVerificationFailed) return 'signature'
  if (err instanceof errors.JOSEAlgNotAllowed) return 'algorithm'
  return 'malformed'
}

export function createBetterAuthAdapter(config: BetterAuthAdapterConfig): AuthAdapter {
  const now = config.now ?? (() => new Date())

  // The JWKS cache ([[CORE244]] P1), per isolate: the keys for 5 minutes; a `kid` it does not know re-reads at most once per 30 seconds; concurrent readers share one read.
  let keys: Map<string, Cached> | undefined
  let filledAt = 0
  let lastRead = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | undefined

  async function load(at: number): Promise<void> {
    inflight ??= (async () => {
      try {
        const rows = await config.readKeys()
        const next = new Map<string, Cached>()
        for (const row of rows) {
          try {
            const jwk = JSON.parse(row.publicJwk) as Record<string, unknown>
            next.set(row.kid, { alg: row.alg, key: await importJWK(jwk as never, row.alg) })
          } catch {
            // a row that is no usable public key verifies nothing; the others still do
          }
        }
        keys = next
        filledAt = at
        lastRead = at
      } finally {
        inflight = undefined
      }
    })()
    await inflight
  }

  async function keyFor(kid: string, at: number): Promise<Cached | null> {
    const fresh = keys !== undefined && at - filledAt < JWKS_CACHE_MS
    if (fresh && keys!.has(kid)) return keys!.get(kid)!
    // Cold or expired: read. Warm but the `kid` is unknown: read only if the last read is old enough, so a stream of forged key ids is not a stream of reads.
    if (!fresh || at - lastRead >= JWKS_UNKNOWN_KID_REREAD_MS) await load(at)
    return keys?.get(kid) ?? null
  }

  return {
    provider: 'better-auth',
    roleSource: 'membership',

    async verify(token): Promise<VerifyResult> {
      let header
      try {
        header = decodeProtectedHeader(token)
      } catch {
        return { ok: false, reason: 'malformed' }
      }
      if (typeof header.alg !== 'string' || !ALGORITHMS.has(header.alg)) return { ok: false, reason: 'algorithm' }
      if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'signature' }
      const known = await keyFor(header.kid, now().getTime())
      if (known === null) return { ok: false, reason: 'signature' }
      if (known.alg !== header.alg) return { ok: false, reason: 'algorithm' }
      let payload
      try {
        ;({ payload } = await jwtVerify(token, known.key, {
          algorithms: [known.alg],
          issuer: config.issuer,
          audience: typeof config.audience === 'string' ? config.audience : [...config.audience],
          clockTolerance: 5,
          currentDate: now(),
          requiredClaims: ['exp', 'sub', 'iat'],
        }))
      } catch (err) {
        return { ok: false, reason: failureReason(err) }
      }
      if (typeof payload.sub !== 'string' || payload.sub === '' || typeof payload.iat !== 'number') return { ok: false, reason: 'claims' }
      const typ = typeof header.typ === 'string' ? header.typ.toLowerCase() : ''
      if (ACCESS_TOKEN_TYPES.has(typ)) {
        // An OAuth access token: the provider's `typ: at+jwt` header marks it, and it names its client. It is never a session, whatever else it carries.
        if (typeof payload.client_id !== 'string' || payload.client_id === '') return { ok: false, reason: 'claims' }
        const scopeClaim: unknown = payload.scope
        const scopes = typeof scopeClaim === 'string' ? scopeClaim.split(/\s+/).filter((s) => s !== '' && !PROVIDER_OWN_SCOPES.has(s)) : []
        return { ok: true, kind: 'oauth', subject: payload.sub, clientId: payload.client_id, scopes: [...new Set(scopes)] }
      }
      // Anything else is a session JWT only when it carries the vault's marker (which the provider's own tokens cannot) and no client: an OIDC ID token has neither.
      if (payload[SESSION_TOKEN_CLAIM] !== SESSION_TOKEN_VALUE || 'client_id' in payload || 'azp' in payload) return { ok: false, reason: 'claims' }
      return { ok: true, kind: 'session', subject: payload.sub, issuedAt: new Date(payload.iat * 1000), organization: null, role: undefined }
    },

    async fetchProfile(subject): Promise<AuthProfile> {
      const profile = await config.readProfile(subject)
      if (profile === null) throw new ProfileNotFoundError('better-auth account not found')
      return { email: profile.email, emailVerified: profile.emailVerified, name: profile.name }
    },

    fetchOAuthClientName: (clientId) => config.readClientName(clientId),
    // Single-organisation D1: no directory, no webhooks (the same refusals as the Clerk workspace adapter).
    fetchOrganization: async () => null,
    listMembers: async () => [],
    parseWebhook: async () => ({ ok: false, reason: 'signature' }),
  }
}
