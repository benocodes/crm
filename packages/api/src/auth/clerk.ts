import { errors, importSPKI, jwtVerify, type CryptoKey } from 'jose'
import type {
  AuthAdapter,
  AuthProfile,
  DirectoryMember,
  DirectoryOrganization,
  VerifyResult,
  WebhookResult,
} from './adapter.js'
import type { Role } from './roles.js'

export interface ClerkConfig {
  /** PEM SPKI; literal "\n" sequences (a PEM pasted into an env var) are turned into newlines first. */
  jwtKey: string
  /** Exact match on iss. */
  issuer: string
  authorizedParties: readonly string[]
  secretKey: string
  /** The Svix signing secret of the webhook endpoint (`whsec_<base64>`). */
  webhookSecret: string
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

interface ClerkOrganization {
  id?: string
  name?: string
}
interface ClerkMembership {
  role?: unknown
  public_user_data?: { user_id?: unknown } | null
}

/** Clerk's organisation role key -> the vault's role. Anything but admin and member is unmapped ([[CORE3]] D19). */
export function mapClerkRole(role: unknown): Role | null {
  if (typeof role !== 'string') return null
  const key = role.startsWith('org:') ? role.slice(4) : role
  if (key === 'admin') return 'owner'
  if (key === 'member') return 'member'
  return null
}

const MEMBERS_PAGE = 100
/** Svix's tolerance: a delivery is refused when its timestamp is further than this from now. */
const WEBHOOK_TOLERANCE_S = 300

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
}

/** The Clerk adapter: networkless RS256 session-token verification, one Backend API call per new user. */
export function createClerkAdapter(config: ClerkConfig): AuthAdapter {
  const apiUrl = (config.apiUrl ?? 'https://api.clerk.com').replace(/\/+$/, '')
  let key: Promise<CryptoKey> | undefined
  const getKey = () => (key ??= importSPKI(config.jwtKey.replace(/\\n/g, '\n'), 'RS256'))
  const backend = (path: string) =>
    (config.fetch ?? globalThis.fetch)(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${config.secretKey}` } })

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
          requiredClaims: ['exp', 'sub', 'iat'],
        }))
      } catch (err) {
        return { ok: false, reason: failureReason(err) }
      }
      if (typeof payload.sub !== 'string' || payload.sub === '') return { ok: false, reason: 'claims' }
      // azp (the requesting origin) may be absent; when present it must be exactly an authorised party.
      if ('azp' in payload && (typeof payload.azp !== 'string' || !config.authorizedParties.includes(payload.azp))) {
        return { ok: false, reason: 'azp' }
      }
      if (typeof payload.iat !== 'number') return { ok: false, reason: 'claims' }
      const issuedAt = new Date(payload.iat * 1000)
      if (!('o' in payload)) return { ok: true, subject: payload.sub, issuedAt, organization: null }
      const o = payload.o as { id?: unknown; rol?: unknown } | null
      if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || o.id === '') return { ok: false, reason: 'claims' }
      return { ok: true, subject: payload.sub, issuedAt, organization: { externalId: o.id, role: mapClerkRole(o.rol) } }
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

    async fetchOrganization(externalId): Promise<DirectoryOrganization | null> {
      const res = await backend(`/v1/organizations/${encodeURIComponent(externalId)}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`clerk organization fetch failed: ${res.status}`)
      const org = (await res.json()) as ClerkOrganization
      return { externalId: String(org.id), name: String(org.name) }
    },

    async listMembers(externalId): Promise<DirectoryMember[]> {
      const members: DirectoryMember[] = []
      for (let offset = 0; ; offset += MEMBERS_PAGE) {
        const res = await backend(
          `/v1/organizations/${encodeURIComponent(externalId)}/memberships?limit=${MEMBERS_PAGE}&offset=${offset}`,
        )
        if (!res.ok) throw new Error(`clerk membership list failed: ${res.status}`)
        const page = (await res.json()) as { data?: ClerkMembership[]; total_count?: number }
        if (!page.data || page.data.length === 0) break
        for (const item of page.data) {
          const subject = item.public_user_data?.user_id
          const role = mapClerkRole(item.role)
          if (typeof subject !== 'string' || subject === '') {
            console.warn('[directory] member skipped', { reason: 'subject' })
          } else if (role === null) {
            console.warn('[directory] member skipped', { reason: 'role' })
          } else members.push({ subject, role })
        }
        if (offset + MEMBERS_PAGE >= (page.total_count ?? 0)) break
      }
      return members
    },

    async parseWebhook({ headers, body }): Promise<WebhookResult> {
      const id = headers.get('svix-id')
      const timestamp = headers.get('svix-timestamp')
      const signatures = headers.get('svix-signature')
      if (!id || !timestamp || !signatures) return { ok: false, reason: 'headers' }
      if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'timestamp' }
      const nowS = (config.now?.() ?? new Date()).getTime() / 1000
      if (Math.abs(nowS - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return { ok: false, reason: 'timestamp' }

      const secret = base64Bytes(config.webhookSecret.replace(/^whsec_/, ''))
      if (!secret) return { ok: false, reason: 'signature' }
      const hmac = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      const content = new TextEncoder().encode(`${id}.${timestamp}.${body}`)
      let verified = false
      for (const entry of signatures.split(' ')) {
        const [version, value] = entry.split(',')
        if (version !== 'v1' || !value) continue
        const sig = base64Bytes(value)
        // Evaluate every entry: verify() is constant-time per signature, and the list is short.
        if (sig && (await crypto.subtle.verify('HMAC', hmac, sig, content))) verified = true
      }
      if (!verified) return { ok: false, reason: 'signature' }

      let event: unknown
      try {
        event = JSON.parse(body)
      } catch {
        return { ok: false, reason: 'payload' }
      }
      if (typeof event !== 'object' || event === null) return { ok: false, reason: 'payload' }
      const { type, data } = event as { type?: unknown; data?: { id?: unknown; organization?: { id?: unknown } | null } | null }
      if (typeof type !== 'string') return { ok: false, reason: 'payload' }
      const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''
      if (/^organization\.(created|updated|deleted)$/.test(type)) {
        return nonEmpty(data?.id) ? { ok: true, change: { kind: 'organization', externalId: data.id } } : { ok: false, reason: 'payload' }
      }
      if (/^organizationMembership\.(created|updated|deleted)$/.test(type)) {
        const externalId = data?.organization?.id
        return nonEmpty(externalId) ? { ok: true, change: { kind: 'organization', externalId } } : { ok: false, reason: 'payload' }
      }
      if (type === 'user.updated') {
        return nonEmpty(data?.id) ? { ok: true, change: { kind: 'user', subject: data.id } } : { ok: false, reason: 'payload' }
      }
      return { ok: true, change: { kind: 'ignored', type } }
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
