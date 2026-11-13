import { isValidPushVar } from '@vibase/api'
import type { AuthRuntimeConfig } from '@vibase/auth'

/** `AUTH_SECRET` is at least this many characters ([[CORE243]] D6, P2): setup generates 32 random bytes as base64url, which is 43. */
export const AUTH_SECRET_MIN_LENGTH = 32

/**
 * The built-in provider's configuration ([[CORE243]] D6, P2), read only for `AUTH_PROVIDER=better-auth`. Throws an Error whose message names the variable and
 * never carries a value (the composition logs it and fails closed). `PUBLIC_BASE_URL` is judged by the rule the Gmail push configuration already uses
 * (`isValidPushVar`: an origin, `https`, or `http://localhost`), and is normalised to its origin: it is the one base URL whatever host a request arrives on (D23).
 */
export function parseBuiltInAuthConfig(env: Record<string, string | undefined>): AuthRuntimeConfig {
  const secret = env.AUTH_SECRET
  if (secret === undefined || secret === '') throw new Error('AUTH_PROVIDER=better-auth requires AUTH_SECRET')
  if (secret !== secret.trim()) throw new Error('AUTH_SECRET must not have leading or trailing whitespace')
  if (secret.length < AUTH_SECRET_MIN_LENGTH) throw new Error(`AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} characters`)
  const base = env.PUBLIC_BASE_URL
  if (base === undefined || base.trim() === '') throw new Error('AUTH_PROVIDER=better-auth requires PUBLIC_BASE_URL')
  if (!isValidPushVar('PUBLIC_BASE_URL', base)) throw new Error('PUBLIC_BASE_URL must be an origin without a path: https, or http://localhost for local development')
  return { secret, baseURL: new URL(base.trim()).origin }
}
