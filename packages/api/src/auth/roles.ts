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
  'contacts:read': { member: true, agentGrantable: true },
  'contacts:write': { member: true, agentGrantable: true },
  'companies:read': { member: true, agentGrantable: true },
  'companies:write': { member: true, agentGrantable: true },
  // Administration ([[CORE3]] D8, D15): humans only. Members read; only owners write.
  'members:read': { member: true, agentGrantable: false },
  'members:write': { member: false, agentGrantable: false },
  'agents:read': { member: true, agentGrantable: false },
  'agents:write': { member: false, agentGrantable: false },
}

/** Owner: every declared scope. Member: declared scopes flagged `member`; no entry means not granted (fail closed). */
export function scopesForRole(role: Role, declared: readonly string[], policy: ScopePolicy = SCOPE_POLICY): ScopeSet {
  if (role === 'owner') return ScopeSet.parse(declared)
  return ScopeSet.parse(declared.filter((s) => policy[s]?.member === true))
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
