// The one log line of a failed email step ([[CORE304]] P2): a fixed event name plus the error's `code` or `name` when it has a plain one. Never the address, the token, the URL, the subject or the body, and never the
// error's message: a provider's message can echo the recipient.
export type EmailFailureEvent = 'invitation_send_failed' | 'invitation_revoke_failed' | 'password_reset_send_failed'

/** A code or name is printed only when it is short and made of identifier characters, so a provider cannot smuggle text through it. */
const PLAIN = /^[A-Za-z0-9_.:-]{1,64}$/

export const emailFailureLine = (event: EmailFailureEvent, err: unknown): string => {
  const e = err as { code?: unknown; name?: unknown } | null | undefined
  const detail = [e?.code, e?.name].find((v): v is string => typeof v === 'string' && PLAIN.test(v))
  return detail === undefined ? `[email] ${event}` : `[email] ${event} ${detail}`
}

export const logEmailFailure = (event: EmailFailureEvent, err: unknown): void => {
  console.error(emailFailureLine(event, err))
}
