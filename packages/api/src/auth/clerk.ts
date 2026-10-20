import { errors, importSPKI, jwtVerify, type CryptoKey } from 'jose'
import type { AuthAdapter, AuthProfile, VerifyResult } from './adapter.js'

export interface ClerkConfig {
  /** PEM SPKI; literal "\n" sequences (a PEM pasted into an env var) are turned into newlines first. */
  jwtKey: string
  /** Exact match on iss. */
  issuer: string
  authorizedParties: readonly string[]
  secretKey: string
  /** Default 'https://api.clerk.com'. */
  apiUrl?: string
  fetch?: typeof fetch
  now?: () => Date
}

interface ClerkEmailAddress {
  id?: string
  email_address?: string
  verification?: { status?: string } | null
}
interface ClerkUser {
  first_name?: string | null
  last_name?: string | null
  primary_email_address_id?: string | null
  email_addresses?: ClerkEmailAddress[]
}

/** The Clerk adapter: networkless RS256 session-token verification, one Backend API call per new user. */
export function createClerkAdapter(config: ClerkConfig): AuthAdapter {
  const apiUrl = (config.apiUrl ?? 'https://api.clerk.com').replace(/\/+$/, '')
  let key: Promise<CryptoKey> | undefined
  const getKey = () => (key ??= importSPKI(config.jwtKey.replace(/\\n/g, '\n'), 'RS256'))

  return {
    provider: 'clerk',

    async verify(token): Promise<VerifyResult> {
      let payload
      try {
        ;({ payload } = await jwtVerify(token, await getKey(), {
          algorithms: ['RS256'],
          issuer: config.issuer,
          clockTolerance: 5,
          currentDate: config.now?.(),
          requiredClaims: ['exp', 'sub'],
        }))
      } catch (err) {
        return { ok: false, reason: failureReason(err) }
      }
      if (typeof payload.sub !== 'string' || payload.sub === '') return { ok: false, reason: 'claims' }
      // azp (the requesting origin) may be absent; when present it must be exactly an authorised party.
      if ('azp' in payload && (typeof payload.azp !== 'string' || !config.authorizedParties.includes(payload.azp))) {
        return { ok: false, reason: 'azp' }
      }
      return { ok: true, subject: payload.sub }
    },

    async fetchProfile(subject): Promise<AuthProfile> {
      const doFetch = config.fetch ?? globalThis.fetch
      const res = await doFetch(`${apiUrl}/v1/users/${encodeURIComponent(subject)}`, {
        headers: { authorization: `Bearer ${config.secretKey}` },
      })
      if (!res.ok) throw new Error(`clerk profile fetch failed: ${res.status}`)
      const user = (await res.json()) as ClerkUser
      const primary = user.email_addresses?.find((e) => e.id === user.primary_email_address_id)
      const name = [user.first_name, user.last_name].map((p) => p?.trim()).filter((p): p is string => !!p).join(' ')
      return {
        email: primary?.email_address ?? null,
        emailVerified: primary ? primary.verification?.status === 'verified' : false,
        name: name === '' ? null : name,
      }
    },
  }
}

function failureReason(err: unknown): Exclude<VerifyResult, { ok: true }>['reason'] {
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
