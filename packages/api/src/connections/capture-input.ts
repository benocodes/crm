import { z } from 'zod'
import { ApiError } from '../errors.js'
import { normalizeIdentityValue } from '../identity/normalize.js'

// The write-side rules of a connection's capture settings ([[CHN406]] D4, D7; [[CHN409]] P2). Exported for [[CHN410]]'s workspace blocklist, which stores the same values.

/** Gmail labels capture never reads, so a list naming one is a mistake ([[CHN406]] D4). */
export const SYSTEM_LABELS: readonly string[] = ['DRAFT', 'SPAM', 'TRASH', 'CHAT']
export const MAX_CAPTURE_LABELS = 50
export const MAX_BLOCKED_SENDERS = 500
const LABEL = /^[A-Za-z0-9_-]{1,100}$/
/** A bare hostname of two or more labels, at most 253 characters; punycode (`xn--`) labels and TLDs are accepted ([[CHN406]] D7, unlike the company-domain rule, which wants a letters-only TLD). */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

export type BlockedSenderInput = { kind: 'address' | 'domain'; value: string }

/** A blocked address as stored: trimmed, lowercased, through the identity email normaliser. Throws a plain `Error` with the reason; the caller adds the index. */
export function normalizeBlockedAddress(value: string): string {
  try {
    return normalizeIdentityValue('email', value)
  } catch (err) {
    // The identity normaliser's `invalid_identity` must not leak: the answer is this operation's `validation_error`.
    throw new Error(err instanceof ApiError ? err.message : 'invalid email address')
  }
}

/** A blocked domain as stored: trimmed, lowercased, a bare hostname. A leading `@` or `.` or a trailing `.` is refused, not stripped ([[CHN409]] P2). */
export function normalizeBlockedDomain(value: string): string {
  const v = value.trim().toLowerCase()
  if (v.startsWith('@') || v.startsWith('.') || v.endsWith('.'))
    throw new Error('a domain is a bare hostname such as example.com, without a leading @ or . or a trailing .')
  if (!DOMAIN.test(v)) throw new Error('invalid domain: a hostname of at least two labels, at most 253 characters')
  return v
}

const labels = z
  .array(z.string().regex(LABEL, 'a Gmail label id is 1 to 100 letters, digits, _ or -'))
  .min(1, 'at least one label')
  .max(MAX_CAPTURE_LABELS, `at most ${MAX_CAPTURE_LABELS} labels`)
  .describe(
    'The Gmail label ids whose messages are captured (1 to 50, never empty, no duplicates). Replaces the whole list. DRAFT, SPAM, TRASH and CHAT are always skipped and refused here. The ids are not checked against the mailbox.',
  )
const blocked = z
  .array(
    z.strictObject({
      kind: z.enum(['address', 'domain']),
      value: z.string().describe('An address (user@example.com) or a bare domain (example.com); stored lowercase.'),
    }),
  )
  .max(MAX_BLOCKED_SENDERS, `at most ${MAX_BLOCKED_SENDERS} entries`)
  .describe(
    "This connection's own blocked senders (0 to 500). Replaces the whole list; an empty list clears it. A malformed or repeated entry is refused, naming its index.",
  )

export const updateBody = z.strictObject({
  capture_labels: labels.optional(),
  blocked_senders: blocked.optional(),
  exclude_group_addresses: z.boolean().optional().describe('Leave mail from group addresses out of capture.'),
  exclude_personal_domains: z.boolean().optional().describe('Leave mail from personal-mail domains out of capture.'),
  contact_creation: z
    .enum(['sent_and_received', 'sent', 'none'])
    .optional()
    .describe('Which captured mail creates contacts for unknown addresses.'),
})

export interface CaptureUpdate {
  capture_labels?: string[]
  blocked_senders?: BlockedSenderInput[]
  exclude_group_addresses?: boolean
  exclude_personal_domains?: boolean
  contact_creation?: 'sent_and_received' | 'sent' | 'none'
}

const refuse = (message: string) => new ApiError(400, 'validation_error', message)

/** Parses and normalises a `connections.update` body. Every refusal is `400 validation_error`, naming the field and, for a list, the index. */
export function parseCaptureUpdate(raw: unknown): CaptureUpdate {
  const parsed = updateBody.safeParse(raw ?? {})
  if (!parsed.success)
    throw refuse(parsed.error.issues.map((i) => [i.path.join('.'), i.message].filter(Boolean).join(': ')).join('; '))
  const body = parsed.data
  if (Object.keys(body).length === 0) throw refuse('send at least one setting to change')
  const out: CaptureUpdate = {}
  if (body.capture_labels) {
    const seen = new Set<string>()
    body.capture_labels.forEach((label, i) => {
      if (SYSTEM_LABELS.includes(label)) throw refuse(`capture_labels[${i}]: ${label} is always skipped`)
      if (seen.has(label)) throw refuse(`capture_labels[${i}]: ${label} is listed twice`)
      seen.add(label)
    })
    out.capture_labels = body.capture_labels
  }
  if (body.blocked_senders) {
    const seen = new Set<string>()
    out.blocked_senders = body.blocked_senders.map((entry, i) => {
      let value: string
      try {
        value = entry.kind === 'address' ? normalizeBlockedAddress(entry.value) : normalizeBlockedDomain(entry.value)
      } catch (err) {
        throw refuse(`blocked_senders[${i}]: ${err instanceof Error ? err.message : 'invalid value'}`)
      }
      const key = `${entry.kind}\u0000${value}`
      if (seen.has(key)) throw refuse(`blocked_senders[${i}]: ${value} is listed twice`)
      seen.add(key)
      return { kind: entry.kind, value }
    })
  }
  for (const k of ['exclude_group_addresses', 'exclude_personal_domains', 'contact_creation'] as const)
    if (body[k] !== undefined) (out as Record<string, unknown>)[k] = body[k]
  return out
}
