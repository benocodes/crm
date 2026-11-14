// The pages' own text for every outcome ([[UI246]] D3, D4, D5, D6). A server `message` is never shown: a known code (or status) maps to one of these, anything else to `genericFailure`.
// One message for every cause of a refusal keeps the pages from being an oracle ([[CORE287]] P2; a wrong email and a wrong password read alike, D5).
export const MESSAGES = {
  // The invite page.
  invitationRefused:
    'This invitation cannot be used. The email address may not be the one that was invited, or the link may have expired, been revoked or already been used. Ask the person who invited you for a new link.',
  inviteAccountExists: 'Your account already exists, but its setup did not finish. Sign in to finish it.',
  inviteNoToken: 'This page needs the invitation link you were sent. Open that link again, or ask the person who invited you for a new one.',
  // The sign-in page.
  wrongCredentials: 'The email or password is wrong.',
  signInAcceptanceFailed: 'Your account is almost ready, but setup did not finish. Sign in again to retry.',
  signInHelp: 'Forgot your password? Ask an owner for a reset link.',
  passwordResetDone: 'Your password has been changed. Sign in with the new one.',
  // The reset page.
  resetInvalidLink: 'This reset link is invalid, expired or already used. Ask an owner for a new link.',
  resetNoToken: 'This page needs the reset link you were sent. Open that link again, or ask an owner for a new one.',
  passwordMismatch: 'The two passwords do not match.',
  // Shared.
  rateLimited: 'Too many attempts. Wait a few seconds and try again.',
  passwordTooShort: 'Use at least 8 characters.',
  passwordTooLong: 'Use at most 128 characters.',
  nameRequired: 'Enter your name.',
  emailRequired: 'Enter your email address.',
  emailInvalid: 'Enter a valid email address.',
  passwordRequired: 'Enter your password.',
  fixFields: 'Fix the highlighted fields.',
  networkFailure: 'Could not reach the server. Check your connection and try again.',
} as const

export const genericFailure = (status: number): string => (status === 0 ? MESSAGES.networkFailure : `Something went wrong (HTTP ${status}). Try again.`)

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128
