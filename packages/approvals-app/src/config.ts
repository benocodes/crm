// Build-time configuration: scripts/build.ts replaces `__APP_CONFIG__` with the JSON of `resolveConfig(process.env)`.
// Nothing here is secret: the publishable key and the issuer are public by design.
export interface AppConfig {
  /** The vault's API origin, e.g. https://api.hq.vibase.ai. */
  apiOrigin: string
  /** The Clerk Frontend API origin that serves clerk-js, e.g. https://clerk.hq.vibase.ai. */
  clerkIssuer: string
  clerkPublishableKey: string
}

export const HQ_DEFAULTS: AppConfig = {
  apiOrigin: 'https://api.hq.vibase.ai',
  clerkIssuer: 'https://clerk.hq.vibase.ai',
  clerkPublishableKey: 'pk_live_Y2xlcmsuaHEudmliYXNlLmFpJA',
}

/** Env overrides (APPROVALS_API_ORIGIN, APPROVALS_CLERK_ISSUER, APPROVALS_CLERK_PK) for a local or staging build; defaults are `hq`. */
export function resolveConfig(env: Record<string, string | undefined>): AppConfig {
  const origin = (v: string, name: string): string => {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error(`${name} must be https`)
    return u.origin
  }
  return {
    apiOrigin: origin(env.APPROVALS_API_ORIGIN || HQ_DEFAULTS.apiOrigin, 'APPROVALS_API_ORIGIN'),
    clerkIssuer: origin(env.APPROVALS_CLERK_ISSUER || HQ_DEFAULTS.clerkIssuer, 'APPROVALS_CLERK_ISSUER'),
    clerkPublishableKey: env.APPROVALS_CLERK_PK || HQ_DEFAULTS.clerkPublishableKey,
  }
}

/** The CSP of the page (Clerk's guide for clerk-js without components, as in the vault's /connect page). It may call the API origin and nothing else. */
export function csp(c: AppConfig): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${c.clerkIssuer} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    `connect-src 'self' ${c.apiOrigin} ${c.clerkIssuer} https://*.protect.clerk.com:*`,
    "img-src 'self' https://img.clerk.com",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    'frame-src https://challenges.cloudflare.com https://*.protect.clerk.com',
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
