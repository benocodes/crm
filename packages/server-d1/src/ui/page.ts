// Shared by the pages: how a page leaves, and the field rules of the sign-up and reset forms ([[UI246]] D4, D6).
import { MESSAGES, PASSWORD_MAX, PASSWORD_MIN } from './messages.js'

export interface PageProps {
  /** Where a finished page goes; a full page load (the signed-in view reads the new session). Replaced in tests. */
  navigate?: (path: string) => void
}
export const goTo = (path: string): void => location.assign(path)

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const emailError = (email: string): string | undefined => (email === '' ? MESSAGES.emailRequired : ADDRESS.test(email) ? undefined : MESSAGES.emailInvalid)
export const newPasswordError = (password: string): string | undefined => (password.length < PASSWORD_MIN ? MESSAGES.passwordTooShort : password.length > PASSWORD_MAX ? MESSAGES.passwordTooLong : undefined)
