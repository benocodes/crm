import { ApiError } from '../errors.js'
import { createClerkAdapter } from './clerk.js'

export type VerifyFailure = 'malformed' | 'algorithm' | 'signature' | 'expired' | 'not_yet_valid' | 'issuer' | 'azp' | 'claims'
/** Always 401 `unauthenticated`. `reason` is for the middleware's log line, never the response. */
export class AuthFailure extends ApiError {
  constructor(
    readonly reason: VerifyFailure | 'no_email',
    message = 'invalid or expired credentials',
  ) {
    super(401, 'unauthenticated', message)
  }
}
export type VerifyResult = { ok: true; subject: string } | { ok: false; reason: VerifyFailure }
export type AuthProfile = { email: string | null; emailVerified: boolean; name: string | null }

/**
 * The seam between the vault and an identity provider ([[CORE3]] D2). `verify` is networkless; `fetchProfile`
 * is the one network call, made once per new subject.
 */
export interface AuthAdapter {
  /** Stored in users.auth_provider. 'clerk' for the Clerk adapter. */
  readonly provider: string
  /** Networkless. Never throws for a bad token; returns the reason. */
  verify(token: string): Promise<VerifyResult>
  /** Called once per new subject, outside any transaction. Throws on transport or HTTP failure. */
  fetchProfile(subject: string): Promise<AuthProfile>
}

export type AuthEnv = Record<string, string | undefined>

/** undefined when AUTH_PROVIDER is unset or empty (agent-only setups). Throws on bad config (fail closed). */
export function createAuthAdapter(env: AuthEnv, deps: { fetch?: typeof fetch; now?: () => Date } = {}): AuthAdapter | undefined {
  const provider = env.AUTH_PROVIDER?.trim()
  if (!provider) return undefined
  if (provider !== 'clerk') throw new Error(`unknown AUTH_PROVIDER "${provider}"`)
  const need = (name: string): string => {
    const v = env[name]
    if (v === undefined || v.trim() === '') throw new Error(`AUTH_PROVIDER=clerk requires ${name}`)
    return v
  }
  const jwtKey = need('CLERK_JWT_KEY')
  const issuer = need('CLERK_ISSUER')
  const secretKey = need('CLERK_SECRET_KEY')
  need('CLERK_AUTHORIZED_PARTIES')
  const authorizedParties = parseOriginList(env.CLERK_AUTHORIZED_PARTIES, 'CLERK_AUTHORIZED_PARTIES')
  if (authorizedParties.length === 0) throw new Error('AUTH_PROVIDER=clerk requires CLERK_AUTHORIZED_PARTIES')
  return createClerkAdapter({
    jwtKey,
    issuer,
    authorizedParties,
    secretKey,
    apiUrl: env.CLERK_API_URL?.trim() || undefined,
    fetch: deps.fetch,
    now: deps.now,
  })
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/

function isOrigin(entry: string): boolean {
  if (EXTENSION_ORIGIN.test(entry)) return true
  try {
    const url = new URL(entry)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry
  } catch {
    return false
  }
}

/**
 * Comma-separated origins: trim, drop empties, strip one trailing '/'; each must be exactly an http(s) origin
 * or a Chrome extension origin ([[CORE3]] D17: the WHATWG URL origin of an extension is opaque). Throws naming `name`.
 */
export function parseOriginList(value: string | undefined, name: string): string[] {
  const out: string[] = []
  for (const raw of (value ?? '').split(',')) {
    let entry = raw.trim()
    if (entry === '') continue
    if (entry.endsWith('/')) entry = entry.slice(0, -1)
    if (!isOrigin(entry)) throw new Error(`${name}: "${entry}" is not an origin`)
    out.push(entry)
  }
  return out
}
