import type { PreparedEnv } from './storage/definition.js'
import { ApiError } from './errors.js'
import type { Operation, OperationInput, PrepareContext, Registry, TenantOperation } from './registry.js'
import { ScopeSet, formatScope, type Scope } from './scopes.js'

// [[AGT8]] D2, D32, D34, D40: the proposal metadata of the registry. One module answers "may this operation be proposed, and what does
// proposing it need", for the action-request operations, the refusal hint, discovery (OpenAPI, tool descriptions) and the manifest test.

/** What a client is told about an operation ([[AGT8]] D40): the `x-vibase-proposal` extension of OpenAPI. */
export interface ProposalMeta {
  eligible: boolean
  /** Why not, when `eligible` is false. */
  reason?: string
  /** The scope that lets a caller propose it: `<resource>:request_approval` (write contains it). */
  request_scope?: string
  /** What the call needs beyond its scope, when only its arguments show it (associations: read on both endpoint types). */
  also_requires?: string
}

export const proposalScopeOf = (scope: Scope): Scope => ({ resource: scope.resource, action: 'request_approval' })

export function proposalMeta(op: Operation): ProposalMeta {
  if (op.kind !== 'tenant') return { eligible: false, reason: 'not a record operation' }
  if (!op.proposal) return { eligible: false, reason: 'read-only operation' }
  if (!op.proposal.eligible) return { eligible: false, reason: op.proposal.reason }
  return {
    eligible: true,
    ...(op.scope ? { request_scope: formatScope(proposalScopeOf(op.scope)) } : {}),
    ...(op.proposal.alsoRequires ? { also_requires: op.proposal.alsoRequires } : {}),
  }
}

/** The proposable operations of a registry, in registry order: what the `operation` enum of `action_requests.create` lists. */
export const proposableOperations = (registry: Registry): TenantOperation[] =>
  registry.operations().filter((o): o is TenantOperation => o.kind === 'tenant' && o.proposal?.eligible === true)

/**
 * The scopes a proposer is checked as when the target runs its own checks ([[AGT8]] D34): `request_approval` on the target's resource
 * stands in for the `write` the operation names, so the target's own validation, agent-field rule and read requirements run unchanged
 * and a caller sees the error a direct call would give. Reads are never elevated. Nothing is stored or returned: the elevated set only
 * exists while the target's `prepare` validates.
 */
export function proposerScopes(scopes: ScopeSet, op: TenantOperation): ScopeSet {
  if (op.scope === null) return scopes
  return ScopeSet.parse([...scopes.toStrings(), formatScope(op.scope)])
}
export const canPropose = (scopes: ScopeSet, op: TenantOperation): boolean => op.scope !== null && scopes.has(proposalScopeOf(op.scope))

const refuseReads: PrepareContext = {
  read() {
    throw new Error('a proposable operation reads nothing while it is prepared')
  },
}
export { refuseReads as noReads }

/**
 * [[AGT8]] (user decision, 2026-11-06): when a caller is refused a direct write with `403 insufficient_scope` and can propose the same
 * call, the refusal says how. The hint needs the FULL scope needs of this call (D32: an association also needs reads on both ends), so
 * it validates the call as a proposal would and gives no hint when that validation itself is refused for a missing scope. A caller
 * with no proposal authority, or an operation that is not proposable, gets no hint.
 */
export async function proposalHint(op: TenantOperation, env: PreparedEnv, input: OperationInput): Promise<string | null> {
  if (op.proposal?.eligible !== true || !canPropose(env.scopes, op)) return null
  try {
    await op.prepare({ ...env, scopes: proposerScopes(env.scopes, op) }, input, refuseReads)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'insufficient_scope') return null
    // Any other refusal (a bad argument) is the proposal's refusal too; the way to propose is still the same call.
  }
  const who = env.actor.kind === 'agent' ? 'this agent' : 'you'
  return `${who} can propose this change but not run it: call action_requests.create with operation=${op.name} and the same arguments, plus a reason`
}
