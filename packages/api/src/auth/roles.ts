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
  // Schema discovery ([[API63]] D8): designing against the schema is expected agent work.
  'schema:read': { member: true, agentGrantable: true },
  // Administration ([[CORE3]] D8, D15): humans only. Members read; only owners write agents. Memberships are
  // read-only: Clerk is the source of truth ([[CORE3]] D1).
  'members:read': { member: true, agentGrantable: false },
  'agents:read': { member: true, agentGrantable: false },
  'agents:write': { member: false, agentGrantable: false },
}

/**
 * One consent-screen sentence per declared scope ([[OPS65]] D40): `setup:remote` lists them as the Clerk scope catalog's descriptions.
 * The same catalog test holds the keys equal to the declared scopes.
 */
export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'tasks:read': 'View tasks and their status',
  'tasks:write': 'Create, change and complete tasks',
  'tasks:request_approval': 'Propose changes to tasks for review',
  'contacts:read': 'View contacts and their details',
  'contacts:write': 'Create, change and merge contacts',
  'contacts:request_approval': 'Propose changes to contacts for review',
  'companies:read': 'View companies and their details',
  'companies:write': 'Create, change and merge companies',
  'companies:request_approval': 'Propose changes to companies for review',
  'interactions:read': 'See who talked to whom, and when, across email, calendar and chat',
  'messages:read': 'Read the content of messages and threads',
  'files:read': 'Read attachments and other stored files',
  'associations:read': 'View the links between contacts, companies and other records',
  'associations:write': 'Create and remove links between records',
  'associations:request_approval': 'Propose changes to associations for review',
  'notes:read': 'View notes on records',
  'notes:write': 'Create, change and delete notes',
  'notes:request_approval': 'Propose changes to notes for review',
  'tags:read': 'View tags (named lists)',
  'tags:write': 'Create, rename and delete tags',
  'tags:request_approval': 'Propose changes to tags for review',
  'deals:read': 'View deals (also called opportunities)',
  'deals:write': 'Create, change, move and delete deals',
  'deals:request_approval': 'Propose changes to deals for review',
  'pipelines:read': 'View pipelines and their stages',
  'pipelines:write': 'Create, change and delete pipelines and stages',
  'pipelines:request_approval': 'Propose changes to pipelines for review',
  'action_requests:read': 'View the queue of proposed changes and how each was decided',
  'connections:read': 'See which mailboxes are connected and whether they are syncing',
  'connections:write': 'Connect and disconnect mailboxes',
  'schema:read': 'Read the data schema: record types, fields and relations',
  'members:read': 'View the members of the workspace',
  'agents:read': 'View the workspace agents and their access',
  'agents:write': 'Create, change and revoke agents and their API keys',
}

/** Owner: every declared scope. Member: declared scopes flagged `member`; no entry means not granted (fail closed). */
export function scopesForRole(role: Role, declared: readonly string[], policy: ScopePolicy = SCOPE_POLICY): ScopeSet {
  // [[AGT8]] D31: closed under write => request_approval, whatever the policy rows say.
  if (role === 'owner') return ScopeSet.closed(declared, declared)
  return ScopeSet.closed(declared.filter((s) => policy[s]?.member === true), declared)
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
