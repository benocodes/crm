// The invitation message ([[CORE248]] D6): a pure builder beside `invitationUrl`. Fixed English text; a plain-text part and a minimal HTML part (no images, no tracking, no remote resources), the link in both, the HTML escaped.
// The only variable content is the instance's host, the invited role, the link and its expiry: no inviter name, organisation name or other caller-supplied string, so nothing a caller types reaches a mailbox.
// Never logged or stored by the caller.

/** The five characters that matter in text and in a double-quoted attribute. */
export const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export interface InvitationMessageInput {
  /** The instance's host (from `PUBLIC_BASE_URL`, never a request). */
  host: string
  /** The invitation link, token in the fragment. */
  url: string
  role: string
  /** ISO-8601; shown as its date. */
  expiresAt: string
}

export function invitationMessage(a: InvitationMessageInput): { subject: string; text: string; html: string } {
  const expires = a.expiresAt.slice(0, 10)
  const subject = `You're invited to Vibase at ${a.host}`
  const text = [
    `You have been invited to Vibase at ${a.host} as ${a.role}.`,
    '',
    'Open this link to accept the invitation and create your account:',
    a.url,
    '',
    `The link works once and expires on ${expires}. If you were not expecting it, ignore this message.`,
    '',
  ].join('\n')
  const html = [
    '<!doctype html><html><body>',
    `<p>You have been invited to Vibase at ${escapeHtml(a.host)} as ${escapeHtml(a.role)}.</p>`,
    `<p><a href="${escapeHtml(a.url)}">Accept the invitation</a></p>`,
    `<p>Or open this link: ${escapeHtml(a.url)}</p>`,
    `<p>The link works once and expires on ${escapeHtml(expires)}. If you were not expecting it, ignore this message.</p>`,
    '</body></html>',
  ].join('\n')
  return { subject, text, html }
}

export interface PasswordResetMessageInput {
  /** The instance's host (from `PUBLIC_BASE_URL`, never a request). */
  host: string
  /** The reset link, token in the fragment ([[UI246]] D6: `passwordResetUrl`). */
  url: string
}

/**
 * The password-reset message ([[CORE304]] D6, the self-service request of [[CORE248]] D4): fixed English text, a plain part and a minimal HTML part, the link in both, the HTML escaped. The only variable content is the
 * host and the link (and the link lives one hour: Better Auth's `resetPasswordTokenExpiresIn`, [[CORE243]] D15), so nothing a caller types reaches a mailbox. Never logged or stored by the caller.
 */
export function passwordResetMessage(a: PasswordResetMessageInput): { subject: string; text: string; html: string } {
  const subject = `Reset your Vibase password at ${a.host}`
  const text = [
    `Someone asked to reset the password of your Vibase account at ${a.host}.`,
    '',
    'Open this link to choose a new password:',
    a.url,
    '',
    'The link works once and expires in 1 hour. Setting a new password signs you out everywhere. If you did not ask for this, ignore this message: your password has not changed.',
    '',
  ].join('\n')
  const html = [
    '<!doctype html><html><body>',
    `<p>Someone asked to reset the password of your Vibase account at ${escapeHtml(a.host)}.</p>`,
    `<p><a href="${escapeHtml(a.url)}">Choose a new password</a></p>`,
    `<p>Or open this link: ${escapeHtml(a.url)}</p>`,
    '<p>The link works once and expires in 1 hour. Setting a new password signs you out everywhere. If you did not ask for this, ignore this message: your password has not changed.</p>',
    '</body></html>',
  ].join('\n')
  return { subject, text, html }
}
