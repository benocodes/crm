import { isValidPushVar, parseWildcardOrigin } from '@vibase/api'
import type { AuthRuntimeConfig } from '@vibase/auth'

/** `AUTH_SECRET` is at least this many characters ([[CORE243]] D6, P2): setup generates 32 random bytes as base64url, which is 43. */
export const AUTH_SECRET_MIN_LENGTH = 32

/**
 * The built-in provider's configuration ([[CORE243]] D6, P2), read only for `AUTH_PROVIDER=better-auth`. Throws an Error whose message names the variable and
 * never carries a value (the composition logs it and fails closed). `PUBLIC_BASE_URL` is judged by the rule the Gmail push configuration already uses
 * (`isValidPushVar`: an origin, `https`, or `http://localhost`), and is normalised to its origin: it is the one base URL whatever host a request arrives on (D23).
 */
/**
 * [[CORE294]] D7: the Google client for sign-in. The `AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET` pair when both are set; else the Gmail client's `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` when both are
 * set; else none. Half of the AUTH pair throws (naming the missing variable, never a value), like an incomplete `AUTH_SECRET`; half of the Gmail pair only leaves Google sign-in off (the Gmail surface keeps
 * its own rules, [[CHN5]] D58). A blank value counts as unset.
 */
export function resolveGoogleSignIn(
  env: Record<string, string | undefined>,
): { clientId: string; clientSecret: string } | undefined {
  const get = (name: string): string | undefined => {
    const v = env[name]?.trim()
    return v === undefined || v === '' ? undefined : v
  }
  const authId = get('AUTH_GOOGLE_CLIENT_ID')
  const authSecret = get('AUTH_GOOGLE_CLIENT_SECRET')
  if (authId !== undefined && authSecret === undefined)
    throw new Error('AUTH_GOOGLE_CLIENT_ID is set but AUTH_GOOGLE_CLIENT_SECRET is not: set both or neither')
  if (authSecret !== undefined && authId === undefined)
    throw new Error('AUTH_GOOGLE_CLIENT_SECRET is set but AUTH_GOOGLE_CLIENT_ID is not: set both or neither')
  if (authId !== undefined && authSecret !== undefined) return { clientId: authId, clientSecret: authSecret }
  const gmailId = get('GOOGLE_CLIENT_ID')
  const gmailSecret = get('GOOGLE_CLIENT_SECRET')
  return gmailId !== undefined && gmailSecret !== undefined
    ? { clientId: gmailId, clientSecret: gmailSecret }
    : undefined
}

/**
 * [[UI255]] D6: `AUTH_TRUSTED_ORIGINS`, a comma-separated list of first-party app origins. Each entry is an origin by `PUBLIC_BASE_URL`'s rule (`https`, or `http://localhost[:port]`; no path, query or fragment),
 * or a wildcard `scheme://*.<host>[:port]` whose base is such an origin ([[API622]] D2; matches subdomains at any depth). Entries are normalised to their origin, an entry equal to `baseURL` is dropped (already trusted) and repeats collapse. Empty or unset is none. A malformed entry throws a message that names the
 * variable and never a value.
 */
const TRUSTED_ORIGINS_MESSAGE =
  'AUTH_TRUSTED_ORIGINS must be a comma-separated list of origins without a path: https, or http://localhost for local development'

export function parseTrustedOrigins(value: string | undefined, baseURL: string): string[] {
  const out: string[] = []
  for (const raw of (value ?? '').split(',')) {
    let entry = raw.trim()
    if (entry === '') continue
    if (entry.includes('*')) {
      // [[API622]] D2: the wildcard keeps its `*.`, so the base is validated by this var's own rule (https, or http://localhost[:port]).
      if (entry.endsWith('/')) entry = entry.slice(0, -1)
      entry = entry.toLowerCase()
      const base = parseWildcardOrigin(entry)
      if (base === undefined || !isValidPushVar('PUBLIC_BASE_URL', base)) throw new Error(TRUSTED_ORIGINS_MESSAGE)
      if (!out.includes(entry)) out.push(entry)
      continue
    }
    if (!isValidPushVar('PUBLIC_BASE_URL', entry)) throw new Error(TRUSTED_ORIGINS_MESSAGE)
    const origin = new URL(entry).origin
    if (origin !== baseURL && !out.includes(origin)) out.push(origin)
  }
  return out
}

export function parseBuiltInAuthConfig(env: Record<string, string | undefined>): AuthRuntimeConfig {
  const secret = env.AUTH_SECRET
  if (secret === undefined || secret === '') throw new Error('AUTH_PROVIDER=better-auth requires AUTH_SECRET')
  if (secret !== secret.trim()) throw new Error('AUTH_SECRET must not have leading or trailing whitespace')
  if (secret.length < AUTH_SECRET_MIN_LENGTH)
    throw new Error(`AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} characters`)
  const base = env.PUBLIC_BASE_URL
  if (base === undefined || base.trim() === '') throw new Error('AUTH_PROVIDER=better-auth requires PUBLIC_BASE_URL')
  if (!isValidPushVar('PUBLIC_BASE_URL', base))
    throw new Error(
      'PUBLIC_BASE_URL must be an origin without a path: https, or http://localhost for local development',
    )
  const google = resolveGoogleSignIn(env)
  const baseURL = new URL(base.trim()).origin
  return {
    secret,
    baseURL,
    trustedOrigins: parseTrustedOrigins(env.AUTH_TRUSTED_ORIGINS, baseURL),
    ...(google ? { google } : {}),
  }
}
