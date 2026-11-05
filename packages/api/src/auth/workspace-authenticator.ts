import { ApiError } from '../errors.js'
import { ScopeSet } from '../scopes.js'
import { AuthFailure, ProfileNotFoundError, type AuthAdapter, type AuthProfile } from './adapter.js'
import { lookupPrincipal, provisionAgent } from './agent-principals.js'
import { provisionUser } from './first-sight.js'
import { resolveActiveOrganization } from './organization.js'
import { SCOPE_POLICY, isAgentGrantable, scopesForRole, type Role, type ScopePolicy } from './roles.js'
import type { Principal, UserAuthenticator } from './types.js'

/** The workspace role of a token's claim or a profile's metadata; anything but `owner` and `member` (a missing, unknown or `agent` value) is null ([[CORE64]] D9). */
export function workspaceRole(claim: unknown): Role | null {
  return claim === 'owner' || claim === 'member' ? claim : null
}

/** How long a profile read is kept, per isolate ([[CORE77]] D12): about a Clerk session token's life. */
export const PROFILE_CACHE_MS = 60_000
const PROFILE_CACHE_MAX = 1000

const forbidden = () => new ApiError(403, 'organization_forbidden', 'not a member of that organisation')

/** The cached profile read ([[CORE77]] D12), one per isolate: what the authenticator and the Gmail callback's role re-check ([[CHN5]] D33) both read. */
export interface ProfileCache {
  /** The provider's profile for a subject; null when the provider says it is gone (a 404, cached too); throws on any other failure (not cached). */
  profileOf(subject: string, nowMs: number): Promise<AuthProfile | null>
}
export function createProfileCache(adapter: AuthAdapter): ProfileCache {
  // The profile cache (D12): per isolate, by subject. A refusal (`null`) is cached too; a Backend failure is not.
  const cache = new Map<string, { until: number; profile: AuthProfile | null }>()
  return {
    async profileOf(subject, nowMs) {
      const hit = cache.get(subject)
      if (hit && hit.until > nowMs) return hit.profile
      let profile: AuthProfile | null
      try {
        profile = await adapter.fetchProfile(subject)
      } catch (err) {
        if (!(err instanceof ProfileNotFoundError)) throw err
        profile = null
      }
      if (cache.size >= PROFILE_CACHE_MAX) for (const [k, v] of cache) if (v.until <= nowMs) cache.delete(k)
      cache.set(subject, { until: nowMs + PROFILE_CACHE_MS, profile })
      return profile
    },
  }
}

/**
 * The D1 workspace authenticator ([[CORE64]] D8-D10, D24; [[CORE77]] D12-D17). A verified Clerk token resolves to one of three principals:
 *
 * - a **session token** carries the role in its `vibase_role` claim (read on every request, no network): a person is a user principal,
 *   role `agent` is an agent account;
 * - an **OAuth access token** carries no role, so the profile supplies it (a cached Backend read, 60 s; a `404` is a refusal). A client that is
 *   `cliClientId` makes the person act as themselves (user, scopes = role ∩ token); any other client is the person's **delegated agent**, created
 *   on first sight, with scopes = token ∩ cap ∩ role ∩ agent-grantable (D15); role `agent` is the agent account whatever the client.
 *
 * Kinds never convert: a user with role `agent`, or an agent-linked subject with a human role, is `403 organization_forbidden`. A refused
 * token (no admissible role, unknown subject, kind mismatch) writes nothing; a disabled agent is `401`. The organisation is the deployment's
 * (the D1 binding): an `o` claim is ignored and no `memberships` row is read or written. `policy` is the scope policy (default: the vault's).
 */
export function createWorkspaceAuthenticator(opts: {
  adapter: AuthAdapter
  declaredScopes: readonly string[]
  cliClientId?: string
  policy?: ScopePolicy
  /** Shared with the Gmail callback's role re-check; default: a cache of this authenticator's own. */
  profiles?: ProfileCache
}): UserAuthenticator {
  const { adapter, declaredScopes, cliClientId } = opts
  const policy = opts.policy ?? SCOPE_POLICY
  const profiles = opts.profiles ?? createProfileCache(adapter)
  const declared = new Set(declaredScopes)
  const grantable = declaredScopes.filter((s) => isAgentGrantable(s, policy)).sort()

  const profileOf = (subject: string, nowMs: number) => profiles.profileOf(subject, nowMs)

  const meet = (...lists: ReadonlyArray<readonly string[]>): string[] =>
    declaredScopes.filter((s) => lists.every((l) => l.includes(s))).sort()

  return {
    async authenticate(token, { storage, organizationHeader, env }) {
      const verified = await adapter.verify(token)
      if (!verified.ok) throw new AuthFailure(verified.reason)
      if (storage.kind !== 'd1') throw new Error('the workspace authenticator serves a D1 deployment only')
      const provider = adapter.provider
      const nowMs = env.now.getTime()
      const oauth = verified.kind === 'oauth'
      const tokenScopes = verified.kind === 'oauth' ? verified.scopes.filter((s) => declared.has(s)) : null
      const clientId = verified.kind === 'oauth' ? verified.clientId : null

      // The role: the claim of a session token, the profile's metadata for an OAuth token (D12).
      let rawRole: unknown
      let profile: AuthProfile | null = null
      if (verified.kind === 'session') rawRole = verified.role
      else {
        profile = await profileOf(verified.subject, nowMs)
        if (profile === null) {
          console.warn('[auth] profile not found')
          throw forbidden()
        }
        rawRole = profile.role
      }
      const isAgentAccount = rawRole === 'agent'
      const role = workspaceRole(rawRole)
      if (role === null && !isAgentAccount) {
        console.warn('[auth] missing or unmapped workspace role')
        throw forbidden()
      }

      // The cached profile also serves first sight (D12); a removed person is refused there too, before anything is written.
      const profileForFirstSight = async (subject: string): Promise<AuthProfile> => {
        const p = await profileOf(subject, nowMs)
        if (p === null) throw new ProfileNotFoundError()
        return p
      }
      const refuseRemoved = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work()
        } catch (err) {
          if (!(err instanceof ProfileNotFoundError)) throw err
          console.warn('[auth] profile not found')
          throw forbidden()
        }
      }

      const delegating = oauth && clientId !== cliClientId
      const found = await lookupPrincipal(storage, { provider, subject: verified.subject, clientId: delegating ? clientId : null })

      // Every principal lives in the deployment's organisation; a header naming another is a cross-check failure ([[CORE3]] D7).
      const organizationId = storage.organizationId
      const wrongOrganization = organizationHeader !== undefined && organizationHeader.toLowerCase() !== organizationId.toLowerCase()
      const agentPrincipal = (agentId: string, scopes: string[]): Principal =>
        wrongOrganization
          ? { actor: { id: agentId, kind: 'agent' }, organizationId: null, scopes: ScopeSet.parse([]), organizationForbidden: true, ...(clientId ? { clientId } : {}) }
          : { actor: { id: agentId, kind: 'agent' }, organizationId, scopes: ScopeSet.parse(scopes), ...(clientId ? { clientId } : {}) }

      if (isAgentAccount) {
        if (found.userId !== null) {
          console.warn('[auth] kind mismatch: a user with role agent')
          throw forbidden()
        }
        const account =
          found.account ??
          (await refuseRemoved(async () => {
            const p = await profileForFirstSight(verified.subject)
            const name = [p.name, p.email, verified.subject].find((n): n is string => typeof n === 'string' && n.trim() !== '')!.trim()
            return provisionAgent(storage, env, { provider, subject: verified.subject, clientId: null, kind: 'account', name, scopes: [], humanId: null, organizationId })
          }))
        if (account.disabled) throw new AuthFailure('disabled')
        // D17: the grants, narrowed by an OAuth token's scopes; never a human-only scope.
        return agentPrincipal(account.agentId, meet(account.scopes, tokenScopes ?? declaredScopes, grantable))
      }

      if (found.account !== null) {
        console.warn('[auth] kind mismatch: an agent account with a human role')
        throw forbidden()
      }
      const humanRole = role!
      const login =
        found.userId !== null
          ? { userId: found.userId }
          : await refuseRemoved(() => provisionUser(storage, adapter, verified.subject, env, profileForFirstSight))

      if (!delegating) {
        // A session token, or the first-party CLI acting as the person (D16).
        const actor = { id: login.userId, kind: 'user' as const }
        const resolved = resolveActiveOrganization({ organizationId, role: humanRole }, organizationHeader)
        if (resolved.organizationId === null) return { actor, organizationId: null, scopes: ScopeSet.parse([]), organizationForbidden: true, ...(clientId ? { clientId } : {}) }
        const roleScopes = scopesForRole(resolved.role, declaredScopes, policy).toStrings()
        return {
          actor,
          organizationId: resolved.organizationId,
          scopes: ScopeSet.parse(tokenScopes ? meet(roleScopes, tokenScopes) : roleScopes),
          role: resolved.role,
          ...(clientId ? { clientId } : {}),
        }
      }

      // Any other OAuth client: the person's delegated agent for this client (D15), created on first sight.
      let delegated = found.userId !== null ? found.delegated : null
      if (delegated === null) {
        const p = await profileForFirstSight(verified.subject)
        const clientName = await adapter.fetchOAuthClientName(clientId!).catch(() => null)
        const name = `${clientName ?? clientId} (${p.email ?? verified.subject})`
        delegated = await provisionAgent(storage, env, { provider, subject: verified.subject, clientId, kind: 'delegated', name, scopes: grantable, humanId: login.userId, organizationId })
      }
      if (delegated.disabled) throw new AuthFailure('disabled')
      const roleScopes = scopesForRole(humanRole, declaredScopes, policy).toStrings()
      return agentPrincipal(delegated.agentId, meet(tokenScopes!, delegated.scopes, roleScopes, grantable))
    },
  }
}
