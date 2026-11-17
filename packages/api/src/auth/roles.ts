import { ScopeSet } from '../scopes.js'

export type Role = 'owner' | 'member'
/** Per scope: does a plain member hold it, and may an agent be granted it ([[CORE3]] D8). */
export type ScopePolicy = Readonly<Record<string, { member: boolean; agentGrantable: boolean }>>

/**
 * One row per declared scope. A catalog test requires the keys to equal the registry's declared scopes, so a
 * spec that declares a scope must classify it here. Downstream rows are pinned in the CORE3 plan (C9).
 */
export const SCOPE_POLICY: ScopePolicy = {
  'tasks:read': { member: true, agentGrantable: true },
  'tasks:write': { member: true, agentGrantable: true },
  'tasks:request_approval': { member: true, agentGrantable: true },
  'contacts:read': { member: true, agentGrantable: true },
  'contacts:write': { member: true, agentGrantable: true },
  'contacts:request_approval': { member: true, agentGrantable: true },
  'companies:read': { member: true, agentGrantable: true },
  'companies:write': { member: true, agentGrantable: true },
  'companies:request_approval': { member: true, agentGrantable: true },
  // Messaging ([[CORE25]] D25): the privacy split - who talked to whom (interactions), what was said (messages, threads), the bytes (files).
  'interactions:read': { member: true, agentGrantable: true },
  'messages:read': { member: true, agentGrantable: true },
  'messages:write': { member: true, agentGrantable: true },
  'messages:request_approval': { member: true, agentGrantable: true },
  'files:read': { member: true, agentGrantable: true },
  // Associations ([[CORE62]] D11): linking needs the grant plus read on both endpoint types, checked by the operation.
  'associations:read': { member: true, agentGrantable: true },
  'associations:write': { member: true, agentGrantable: true },
  'associations:request_approval': { member: true, agentGrantable: true },
  // Notes ([[CORE74]] D8): any holder of notes:write may edit any note.
  'notes:read': { member: true, agentGrantable: true },
  'notes:write': { member: true, agentGrantable: true },
  'notes:request_approval': { member: true, agentGrantable: true },
  // Tags ([[CORE129]] D6): tagging a record is associations:write plus read on both ends, so tags:write is only for managing lists.
  'tags:read': { member: true, agentGrantable: true },
  'tags:write': { member: true, agentGrantable: true },
  'tags:request_approval': { member: true, agentGrantable: true },
  // Deals and pipelines ([[CORE130]] D16): `pipelines:*` also covers the stages. deals:write alone files and moves a deal; the vault validates the stage.
  'deals:read': { member: true, agentGrantable: true },
  'deals:write': { member: true, agentGrantable: true },
  'deals:request_approval': { member: true, agentGrantable: true },
  'pipelines:read': { member: true, agentGrantable: true },
  'pipelines:write': { member: true, agentGrantable: true },
  'pipelines:request_approval': { member: true, agentGrantable: true },
  // Action requests ([[AGT8]] D7, D38): the queue is read under its own scope; proposing and deciding follow the target resource (no global write or decide).
  'action_requests:read': { member: true, agentGrantable: true },
  // Connections ([[CHN5]] D20): members connect their own mailboxes; writing needs a person at Google's consent screen, so it is human-only.
  'connections:read': { member: true, agentGrantable: true },
  'connections:write': { member: true, agentGrantable: false },
  // The workspace blocklist ([[CHN406]] D9): members and agents may read it; changing it is the owner's, human-only, and not proposable (no request_approval).
  'blocked_senders:read': { member: true, agentGrantable: true },
  'blocked_senders:write': { member: false, agentGrantable: false },
  // Forms ([[CHN420]] D12): members and agents may read them; opening, changing or closing a public write path is the owner's, human-only, and not proposable (no request_approval).
  'forms:read': { member: true, agentGrantable: true },
  'forms:write': { member: false, agentGrantable: false },
  // The event feed ([[API6]] D4): history of everything the caller may also read; each event is additionally filtered by its resource's own read scope.
  'events:read': { member: true, agentGrantable: true },
  // Webhook subscriptions ([[API7]] D2): integration plumbing, administered by owners and by the agent that owns one. Members never hold them (an endpoint may embed a token); no request_approval (a create answers a secret once).
  'webhooks:read': { member: false, agentGrantable: true },
  'webhooks:write': { member: false, agentGrantable: true },
  // Schema discovery ([[API63]] D8): designing against the schema is expected agent work.
  'schema:read': { member: true, agentGrantable: true },
  // Administration ([[CORE3]] D8, D15): humans only. Members read; only owners write agents. On Clerk memberships are read-only (Clerk is the source of truth, [[CORE3]] D1);
  // `members:write` ([[CORE288]] P1) is the built-in provider's membership administration: owner-held, never a member or agent scope.
  'members:read': { member: true, agentGrantable: false },
  'members:write': { member: false, agentGrantable: false },
  'agents:read': { member: true, agentGrantable: false },
  'agents:write': { member: false, agentGrantable: false },
  // Invitations ([[CORE245]] P1): owner-held and human-only, like agents:write. They live in the control plane; no agent ever holds them, and a member cannot read who was invited.
  'invitations:read': { member: false, agentGrantable: false },
  'invitations:write': { member: false, agentGrantable: false },
  // The control-plane audit log ([[CORE261]] P2): owner-held, never a member scope; an owner may grant it to an agent, but it is not in any default grant (`NOT_DEFAULT_GRANT`). No write scope: only the control store writes the log.
  'audit:read': { member: false, agentGrantable: true },
}

export { SCOPE_DESCRIPTIONS } from './scope-descriptions.js'

/** Owner: every declared scope. Member: declared scopes flagged `member`; no entry means not granted (fail closed). */
export function scopesForRole(role: Role, declared: readonly string[], policy: ScopePolicy = SCOPE_POLICY): ScopeSet {
  // [[AGT8]] D31: closed under write => request_approval, whatever the policy rows say.
  if (role === 'owner') return ScopeSet.closed(declared, declared)
  return ScopeSet.closed(
    declared.filter((s) => policy[s]?.member === true),
    declared,
  )
}

export function isAgentGrantable(scope: string, policy: ScopePolicy = SCOPE_POLICY): boolean {
  return policy[scope]?.agentGrantable === true
}

export function grantableScopes(declared: readonly string[], policy: ScopePolicy = SCOPE_POLICY): string[] {
  return declared.filter((s) => isAgentGrantable(s, policy)).sort()
}

/** Throws for a scope that is not declared-and-grantable. Unknown scopes are the caller's concern. */
export function assertAgentGrantable(
  scopes: readonly string[],
  declared: readonly string[],
  policy: ScopePolicy = SCOPE_POLICY,
): void {
  for (const s of scopes) {
    if (declared.includes(s) && !isAgentGrantable(s, policy)) throw new Error(`scope not grantable to an agent: ${s}`)
  }
}

/** Scopes grantable to an agent but never part of a default grant ([[CORE261]] P2). */
export const NOT_DEFAULT_GRANT: readonly string[] = ['audit:read']

/** What a dynamically registered client or a default agent holds when nothing narrower is asked: the grantable scopes minus `NOT_DEFAULT_GRANT`. */
export function defaultGrantScopes(declared: readonly string[], policy: ScopePolicy = SCOPE_POLICY): string[] {
  return grantableScopes(declared, policy).filter((s) => !NOT_DEFAULT_GRANT.includes(s))
}
