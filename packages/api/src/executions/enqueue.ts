import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { Authorisation, TenantOperation } from '../registry.js'
import type { Scope } from '../scopes.js'
import type { PrepareContext, RetryPolicy } from '../registry.js'
import type { PreparedEnv } from '../storage/definition.js'

/** What an author gives to declare an enqueued operation ([[AGT8]] D2, D51, D52, D57). */
export interface EnqueuedSpec {
  name: string
  summary: string
  description?: string
  path: string
  tags?: string[]
  /** The write scope the operation needs (and the resource its `request_approval` belongs to). */
  scope: Scope
  retry?: RetryPolicy
  transport: string
  readScope: Scope
  /** The operation's own arguments, without `idempotency_key` (the builder adds it to the direct call's body). */
  input: z.ZodObject
  authorise?: (env: PreparedEnv, args: Record<string, unknown>, ctx: PrepareContext) => Promise<Authorisation | void>
}

/**
 * Stub of the red commit: a registrable operation with no behaviour (every call is `501 not_implemented`), so the suites open their app and fail on
 * their assertions instead of on a missing function. The implementation replaces it.
 */
export function enqueuedOperation(spec: EnqueuedSpec): TenantOperation {
  return {
    kind: 'tenant',
    surface: 'api',
    name: spec.name,
    summary: spec.summary,
    method: 'post',
    path: spec.path,
    scope: spec.scope,
    proposal: { eligible: false, reason: 'not implemented yet' },
    request: { body: spec.input },
    response: { status: 200, schema: z.object({}) },
    prepare: () => {
      throw new ApiError(501, 'not_implemented', 'enqueued operations are not implemented yet')
    },
  }
}
