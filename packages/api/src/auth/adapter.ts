import { ApiError } from '../errors.js'
import { createClerkAdapter } from './clerk.js'
import type { Role } from './roles.js'

export type VerifyFailure = 'malformed' | 'algorithm' | 'signature' | 'expired' | 'not_yet_valid' | 'issuer' | 'azp' | 'claims'
/** Always 401 `unauthenticated`. `reason` is for the middleware's log line, never the response. */
export class AuthFailure extends ApiError {
  constructor(
    readonly reason: VerifyFailure | 'no_email' | 'disabled',
    message = 'invalid or expired credentials',
  ) {
    super(401, 'unauthenticated', message)
  }
}
export type OrganizationClaim = { externalId: string; role: Role | null } // null = unmapped role ([[CORE3]] D19)
/**
 * A verified token, by kind ([[CORE77]] D13). `session`: a signed-in person's (or agent account's) browser or API session; the workspace
 * role is the claim's value, unvalidated. `oauth`: an OAuth access token issued to a client; its `scopes` are the vault's scope names
 * (the provider's own scopes dropped, [[CORE77]] D18), and it carries no role: the profile does (D12). Only the workspace adapter
 * ever returns `oauth`; the Organizations adapter reads every token as a session token.
 */
export type VerifyResult =
  | { ok: true; kind: 'session'; subject: string; issuedAt: Date; organization: OrganizationClaim | null; role?: unknown }
  | { ok: true; kind: 'oauth'; subject: string; clientId: string; scopes: string[] }
  | { ok: false; reason: VerifyFailure }
/** `role` is the provider's stored workspace role for the user (`public_metadata.vibase_role`), unvalidated; undefined when absent ([[CORE77]] D12). */
export type AuthProfile = { email: string | null; emailVerified: boolean; name: string | null; role?: unknown }
/** The provider answered 404 for the user: removed, or never existed ([[CORE77]] D12). */
export class ProfileNotFoundError extends Error {
  constructor(message = 'provider profile not found') {
    super(message)
  }
}
export type DirectoryOrganization = { externalId: string; name: string }
export type DirectoryMember = { subject: string; role: Role }
export type DirectoryChange =
  | { kind: 'organization'; externalId: string }
  | { kind: 'user'; subject: string }
  | { kind: 'ignored'; type: string }
export type WebhookFailure = 'headers' | 'timestamp' | 'signature' | 'payload'
export type WebhookResult = { ok: true; change: DirectoryChange } | { ok: false; reason: WebhookFailure }

/**
 * The seam between the vault and an identity provider ([[CORE3]] D2, D24). `verify` and `parseWebhook` are
 * networkless; the `fetch*` and `listMembers` calls are the Backend API, made outside any transaction.
 */
export interface AuthAdapter {
  /** Stored in users.auth_provider. 'clerk' for the Clerk adapter. */
  readonly provider: string
  /** Networkless. Never throws for a bad token; returns the reason. */
  verify(token: string): Promise<VerifyResult>
  /** Called once per new subject, outside any transaction. Throws on transport or HTTP failure. */
  fetchProfile(subject: string): Promise<AuthProfile>
  /** The display name of an OAuth client by its client id; null when the provider does not know it. Throws on transport or HTTP failure ([[CORE77]] D15). */
  fetchOAuthClientName(clientId: string): Promise<string | null>
  /** null on 404. Throws on any other failure. */
  fetchOrganization(externalId: string): Promise<DirectoryOrganization | null>
  /** Every member, all pages; unmapped roles dropped with a warn. Throws on failure (a 404 too). */
  listMembers(externalId: string): Promise<DirectoryMember[]>
  /** Networkless. Never throws for a bad request; returns the reason. */
  parseWebhook(req: { headers: Headers; body: string }): Promise<WebhookResult>
}

export type AuthEnv = Record<string, string | undefined>

/** The session-token claim holding the workspace role when `AUTH_ROLE_CLAIM` is unset ([[CORE64]] D8). */
export const DEFAULT_ROLE_CLAIM = 'vibase_role'

/**
 * undefined when AUTH_PROVIDER is unset or empty (agent-only setups). Throws on bad config (fail closed). The Organizations
 * adapter: needs `CLERK_WEBHOOK_SECRET`, reads no role claim. The workspace adapter is `createWorkspaceAuthAdapter`.
 */
export function createAuthAdapter(env: AuthEnv, deps: { fetch?: typeof fetch; now?: () => Date } = {}): AuthAdapter | undefined {
  return build(env, deps, false)
}

/**
 * The D1 workspace adapter ([[CORE64]] D8, D24): `CLERK_WEBHOOK_SECRET` is not read (a value set is ignored, and the adapter then
 * answers every webhook as a bad signature), and the role is read from the claim named by `AUTH_ROLE_CLAIM` (default `vibase_role`).
 */
export function createWorkspaceAuthAdapter(env: AuthEnv, deps: { fetch?: typeof fetch; now?: () => Date } = {}): AuthAdapter | undefined {
  return build(env, deps, true)
}

/**
 * `AUTH_CLI_CLIENT_ID` ([[CORE77]] D14, D16): the first-party CLI's public OAuth client id. Unset means no client is the CLI; set but blank is a
 * configuration error (fail closed: a blank id must never read as "no CLI" by accident, nor match a token with an empty client id).
 */
export function parseCliClientId(env: AuthEnv): string | undefined {
  const raw = env.AUTH_CLI_CLIENT_ID
  if (raw === undefined) return undefined
  const id = raw.trim()
  if (id === '') throw new Error('AUTH_CLI_CLIENT_ID must not be empty')
  return id
}

function build(env: AuthEnv, deps: { fetch?: typeof fetch; now?: () => Date }, workspace: boolean): AuthAdapter | undefined {
  const provider = env.AUTH_PROVIDER?.trim()
  if (!provider) return undefined
  // [[CORE243]] D1: the built-in provider has no token adapter yet (cycle 3, CORE244); the composition mounts its `/auth` handler and the API stays API-key only meanwhile.
  if (provider === 'better-auth') return undefined
  if (provider !== 'clerk') throw new Error(`unknown AUTH_PROVIDER "${provider}"`)
  const need = (name: string): string => {
    const v = env[name]
    if (v === undefined || v.trim() === '') throw new Error(`AUTH_PROVIDER=clerk requires ${name}`)
    return v
  }
  const jwtKey = need('CLERK_JWT_KEY')
  const issuer = need('CLERK_ISSUER')
  const secretKey = need('CLERK_SECRET_KEY')
  if (!workspace) need('CLERK_AUTHORIZED_PARTIES')
  let webhookSecret: string | undefined
  if (!workspace) {
    webhookSecret = need('CLERK_WEBHOOK_SECRET')
    if (!WEBHOOK_SECRET_SHAPE.test(webhookSecret)) throw new Error('CLERK_WEBHOOK_SECRET must be a whsec_ secret')
  }
  let roleClaim: string | undefined
  if (workspace && env.AUTH_ROLE_CLAIM !== undefined) {
    roleClaim = env.AUTH_ROLE_CLAIM.trim()
    if (roleClaim === '') throw new Error('AUTH_ROLE_CLAIM must not be empty')
  }
  const authorizedParties = parseOriginList(env.CLERK_AUTHORIZED_PARTIES, 'CLERK_AUTHORIZED_PARTIES')
  // D1 workspace ([[CORE64]] D8): optional; unset means no party is authorised, so a token carrying any azp is 401.
  if (!workspace && authorizedParties.length === 0) throw new Error('AUTH_PROVIDER=clerk requires CLERK_AUTHORIZED_PARTIES')
  return createClerkAdapter({
    jwtKey,
    issuer,
    authorizedParties,
    secretKey,
    webhookSecret,
    roleClaim,
    oauth: workspace,
    apiUrl: env.CLERK_API_URL?.trim() || undefined,
    fetch: deps.fetch,
    now: deps.now,
  })
}

const WEBHOOK_SECRET_SHAPE = /^whsec_[A-Za-z0-9+/]+={0,2}$/
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
