// Optional auth email ([[CORE248]] D1, D2): the configuration and the one adapter, Cloudflare Email Service's `send_email` binding. The port (`EmailSender`) and the messages live in `@vibase/api`; nothing here
// knows an invitation. Email is on only for `AUTH_PROVIDER=better-auth` with BOTH the `EMAIL` binding and `AUTH_EMAIL_FROM`; the caller reads neither for another provider.
import { normaliseInvitationEmail, type EmailMessage, type EmailSender } from '@vibase/api'

/**
 * The slice of Cloudflare's `SendEmail` binding this adapter uses (`@cloudflare/workers-types` 5.20261113: `send(builder: EmailMessageBuilder)`), so Node tests pass a fake. The object below is an
 * `EmailMessageBuilder`: `from` and `to` (a string or `{ name, email }`), `subject`, `text`, `html`.
 */
export interface EmailBindingLike {
  send(message: {
    to: string
    from: { email: string; name: string }
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

/** The display name every message is sent under. */
export const EMAIL_FROM_NAME = 'Vibase'

/** The sender over a binding: `send` rejects when the binding does. */
export function cloudflareEmailSender(binding: EmailBindingLike, from: string): EmailSender {
  return {
    async send(m: EmailMessage): Promise<void> {
      await binding.send({
        to: m.to,
        from: { email: from, name: EMAIL_FROM_NAME },
        subject: m.subject,
        text: m.text,
        html: m.html,
      })
    },
  }
}

/**
 * The email configuration ([[CORE248]] D2). `undefined`: off (neither variable). `{ from }`: on, the address normalised by the invitation rule (trimmed, lowercased, one `@`, dotted domain). Half a pair or a
 * malformed address throws an Error that names the variable and never carries the value (the composition logs it and fails closed).
 */
export function parseEmailConfig(env: {
  EMAIL?: unknown
  AUTH_EMAIL_FROM?: string | undefined
}): { from: string } | undefined {
  const raw = env.AUTH_EMAIL_FROM
  const hasFrom = raw !== undefined && raw.trim() !== ''
  const hasBinding = env.EMAIL !== undefined && env.EMAIL !== null
  if (!hasFrom && !hasBinding) return undefined // a blank variable counts as unset, as the other auth variables do
  if (!hasBinding)
    throw new Error('AUTH_EMAIL_FROM is set but the EMAIL binding (send_email) is not: set both or neither')
  if (!hasFrom) throw new Error('the EMAIL binding is present but AUTH_EMAIL_FROM is not: set both or neither')
  const from = normaliseInvitationEmail(raw)
  if (from === null) throw new Error('AUTH_EMAIL_FROM must be a bare email address such as invites@example.com')
  return { from }
}
