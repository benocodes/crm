// Invitation tokens ([[CORE245]] P3, P4): 32 random bytes, base64url, stored only as their SHA-256 (hex). Web Crypto only, so the same code runs in workerd.
import type { InvitationRow } from './port.js'

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** SHA-256 of the token text, lowercase hex: the only form the control plane stores. */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The random source is injected, as for API keys; real code passes `crypto.getRandomValues`. */
export async function newInvitationToken(randomBytes: (n: number) => Uint8Array): Promise<{ token: string; hash: string }> {
  const token = base64url(randomBytes(32))
  return { token, hash: await hashInvitationToken(token) }
}

/** `<PUBLIC_BASE_URL>/invite#token=<token>`: the token is in the fragment, which a browser never sends and a server log never sees ([[UI246]] serves `/invite`). */
export const invitationUrl = (publicBaseUrl: string, token: string): string => `${publicBaseUrl.replace(/\/+$/, '')}/invite#token=${token}`

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Trimmed and lowercased; `null` when it is not an address (no whitespace, one `@`, a dotted domain, at most 254 characters). */
export function normaliseInvitationEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  return email.length <= 254 && email.split('@').length === 2 && ADDRESS.test(email) ? email : null
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'
/** Derived at read time from the row and the clock: accepted, then revoked, then expired by `expires_at`; never a stored flag. */
export function invitationStatus(row: Pick<InvitationRow, 'acceptedAt' | 'revokedAt' | 'expiresAt'>, now: Date): InvitationStatus {
  if (row.acceptedAt !== null) return 'accepted'
  if (row.revokedAt !== null) return 'revoked'
  return row.expiresAt > now.toISOString() ? 'pending' : 'expired'
}
