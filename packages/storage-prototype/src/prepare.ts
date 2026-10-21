import { z } from 'zod'
import {
  ApiError,
  parseScope,
  ScopeSet,
  tasks,
  normalizeIdentityValue,
  cleanName,
  addressKey,
  type TaskRecord,
  type ResolveEntry,
  type ResolveResult,
} from '@vault/api'
import { TenancyContextError } from '@vault/db'
import type { ExecutionContext, Preparation, PreparedOperation, LockIntent } from './types.js'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const patchSchema = z.strictObject(
  (tasks.update as z.ZodObject<any>).pick({ title: true, notes: true, status: true }).shape,
)
function admit(context: ExecutionContext, scope: 'tasks:write' | 'contacts:write') {
  if (!context.organizationId)
    throw new TenancyContextError('organization id is required', 'missing_organization')
  if (!context.actor.id) throw new TenancyContextError('principal id is required', 'missing_principal')
  if (!uuid.test(context.organizationId) || !uuid.test(context.actor.id))
    throw new TenancyContextError('organization and principal ids must be UUIDs', 'invalid_id')
  if (!context.scopes.has(parseScope(scope)))
    throw new ApiError(403, 'insufficient_scope', `requires ${scope}`)
}
function description<T>(
  kind: 'task' | 'resolve',
  context: ExecutionContext,
  input: any,
  p: Preparation,
  locks: LockIntent[],
): PreparedOperation<T> {
  if (!z.uuidv7().safeParse(p.operationId).success || !z.iso.datetime().safeParse(p.now).success)
    throw new ApiError(400, 'validation_error', 'invalid preparation metadata')
  const copy = {
    organizationId: context.organizationId.toLowerCase(),
    actor: Object.freeze({ ...context.actor, id: context.actor.id.toLowerCase() }),
    scopes: ScopeSet.parse(context.scopes.toStrings()),
  }
  return Object.freeze({
    kind,
    requiredScope: kind === 'task' ? 'tasks:write' : 'contacts:write',
    context: Object.freeze(copy),
    input: Object.freeze(input),
    operationId: p.operationId,
    now: p.now,
    eventId: p.nextId(),
    rowId: p.nextId(),
    locks: Object.freeze(locks.map((l) => Object.freeze(l))),
  })
}
export function prepareTaskUpdate(
  context: ExecutionContext,
  input: { id: string; patch: unknown },
  p: Preparation,
): PreparedOperation<TaskRecord> {
  admit(context, 'tasks:write')
  if (!uuid.test(input.id)) throw new ApiError(404, 'not_found', 'task not found')
  const parsed = patchSchema.safeParse(input.patch)
  if (!parsed.success) throw new ApiError(400, 'validation_error', parsed.error.message)
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined))
  return description('task', context, { id: input.id.toLowerCase(), patch: Object.freeze(patch) }, p, [
    { table: 'tasks', id: input.id.toLowerCase() },
  ])
}
export function prepareResolveIdentities(
  context: ExecutionContext,
  entries: readonly ResolveEntry[],
  p: Preparation,
): PreparedOperation<ResolveResult[]> {
  admit(context, 'contacts:write')
  if (!Array.isArray(entries) || entries.length > 100)
    throw new ApiError(400, 'validation_error', 'expected 0..100 identities')
  const normalized = entries.map((e, i) => {
    try {
      if (
        !e ||
        !['email', 'phone'].includes(e.kind) ||
        typeof e.value !== 'string' ||
        (e.name !== undefined && typeof e.name !== 'string')
      )
        throw new ApiError(400, 'invalid_identity', 'invalid identity')
      return {
        kind: e.kind,
        value: normalizeIdentityValue(e.kind, e.value),
        name: cleanName(e.name) ?? null,
        ordinal: i,
      }
    } catch (err) {
      if (err instanceof ApiError)
        throw new ApiError(err.status, err.code, `identities[${i}]: ${err.message}`)
      throw err
    }
  })
  // No ids are allocated until all input normalization has succeeded.
  const candidates = normalized.map((e) =>
    Object.freeze({
      ...e,
      cid: p.nextId(),
      iid: p.nextId(),
      ceid: p.nextId(),
      ieid: p.nextId(),
      rid: p.nextId(),
    }),
  )
  return description(
    'resolve',
    context,
    { entries: Object.freeze(candidates) },
    p,
    normalized.map((e) => ({ key: addressKey(context.organizationId.toLowerCase(), e.kind, e.value) })),
  )
}
