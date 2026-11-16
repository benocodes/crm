// The plan's content ([[OPS365]] D3, D6, P4): who becomes which Better Auth user and what happens to each agent. Pure: the snapshot in, the lists out.
import { workspaceRole } from '@vibase/api'
import type { AgentKind, AuthPlan, PlanAgent, PlanClerkOnly, PlanPerson, Snapshot } from './types.js'

export type PlanBody = Pick<AuthPlan, 'people' | 'clerk_only' | 'agents'>

/** The Clerk role an agent account's user carries (`AUTH_PROVIDER` clerk: `public_metadata.vibase_role: agent`, [[CORE77]] D12). */
const AGENT_ROLE = 'agent'

/**
 * `newId` issues the new Better Auth user ids: one per Clerk user, in the order the people then the agents are met, so the same Clerk user never gets two.
 * A person's membership is the live one (not deleted).
 */
export function classify(snapshot: Snapshot, newId: () => string): PlanBody {
  const clerk = new Map(snapshot.clerk_users.map((u) => [u.id, u]))
  const issued = new Map<string, string>()
  const idFor = (clerkId: string): string => {
    let id = issued.get(clerkId)
    if (id === undefined) {
      id = newId()
      issued.set(clerkId, id)
    }
    return id
  }
  const referenced = new Set<string>()
  const liveMembership = new Map(
    snapshot.memberships.filter((m) => m.deleted_at === null).map((m) => [m.user_id, m] as const),
  )

  const people = snapshot.users.map((u): PlanPerson => {
    const base = {
      user_id: u.id,
      email: u.email,
      old_provider: u.auth_provider,
      old_subject: u.auth_subject,
    }
    const match = u.auth_provider === 'clerk' && u.auth_subject !== null ? clerk.get(u.auth_subject) : undefined
    if (!match) {
      return {
        ...base,
        role: null,
        role_raw: null,
        membership: null,
        action: 'none',
        new_auth_user_id: null,
        reason:
          u.auth_provider === 'clerk'
            ? 'vault-only: no Clerk user with this subject; no account is created and the rows stay'
            : 'no Clerk link; no account is created and the rows stay',
      }
    }
    referenced.add(match.id)
    const m = liveMembership.get(u.id)
    return {
      ...base,
      role: workspaceRole(match.role),
      role_raw: match.role,
      membership: m ? { id: m.id, role: m.role } : null,
      action: 'migrate',
      new_auth_user_id: idFor(match.id),
    }
  })

  const agents = snapshot.agents.map((a): PlanAgent => {
    const kind: AgentKind =
      a.auth_client_id !== null ? 'delegated' : a.auth_subject !== null ? 'agent_account' : 'api_key'
    const base = {
      id: a.id,
      name: a.name,
      kind,
      new_auth_user_id: null,
      scopes: kind === 'delegated' ? a.scopes : null,
    }
    // A Clerk user an agent row points at is that agent's, whatever happens to the agent: it is not a Clerk-only user.
    if (kind === 'agent_account' && clerk.has(a.auth_subject!)) referenced.add(a.auth_subject!)
    if (a.disabled_at !== null)
      return { ...base, action: 'keep', reason: `already disabled (${a.disabled_at}); stays as it is` }
    if (kind === 'api_key') return { ...base, action: 'keep' }
    if (kind === 'delegated')
      return {
        ...base,
        action: 'disable',
        reason: 'Clerk OAuth grants are not migrated; the scopes are recorded to re-apply',
      }
    const user = clerk.get(a.auth_subject!)
    if (!user) return { ...base, action: 'disable', reason: 'no Clerk user with this subject; nothing to relink to' }
    if (user.role !== AGENT_ROLE)
      return {
        ...base,
        action: 'disable',
        reason: `its Clerk user is not an agent account (role ${user.role ?? 'none'}); nothing to relink to`,
      }
    return { ...base, action: 'relink', new_auth_user_id: idFor(user.id) }
  })

  const clerk_only = snapshot.clerk_users
    .filter((u) => !referenced.has(u.id))
    .map((u): PlanClerkOnly => ({ clerk_user_id: u.id, email: u.email, role_raw: u.role, action: 'none' }))

  return { people, clerk_only, agents }
}
