import { z } from 'zod'
import { UnitDriftError } from '@vibase/storage'
import { generateApiKey } from '../auth/api-keys.js'
import { ApiError, mapStorageError } from '../errors.js'
import type { ControlEnv, ControlOperation, OperationInput } from '../registry.js'
import { resourceOperations } from '../registry.js'
import { apiKeyRecord, apiKeys, type ApiKeyRecord } from '../resources/api-keys.js'
import { encodeCursor } from '../resources/sort-cursor.js'
import { globPattern, likePattern, type Condition } from '../storage/column-filters.js'
import { prepareListQuery } from '../storage/prepare.js'
import type { ApiKeyStoreFilter, ApiKeyStorePort, ApiKeyStoreRecord, ApiKeyStoreSort } from './api-key-port.js'
import { readAgentForKey } from './crm-key-reads.js'

// `api_keys.create`, `revoke`, `list` and `get` ([[CORE40]] P7), moved onto the control plane by [[CORE351]] ([[CORE259]] D3, D5, D12): control operations run against an `ApiKeyStorePort`. A create or revoke is ONE control
// batch with its `control_audit` row (P1) and writes nothing to the CRM database, no event included; the CRM fact create needs (the agent) is read before the control call. Keys held only in the CRM database are not handled (P2 dropped by the user: none in use). Without a port they answer
// `501 provider_not_configured` (P5).

export type IssuedKey = ApiKeyRecord & { key: string }

const createKeyBody = z.strictObject({
  agent_id: z.uuid(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
})
const idParams = z.object({ id: z.uuid() })
const noStore = () =>
  new ApiError(501, 'provider_not_configured', 'API keys are held in the control plane; this deployment has none')
const notFound = () => new ApiError(404, 'not_found', 'api_key not found')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const recordOf = (r: ApiKeyStoreRecord): ApiKeyRecord => ({
  id: r.id,
  organization_id: r.organizationId,
  agent_id: r.agentId,
  prefix: r.prefix,
  last_used_at: r.lastUsedAt,
  revoked_at: r.revokedAt,
  expires_at: r.expiresAt,
  created_by: r.createdBy,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
})
/** A guarded write that reports `drifted` is planned afresh and run once more; a second drift is `409 conflict`, as the storage unit's `replanOnDrift` did ([[AGT8]] D28). */
async function replanned<T>(name: string, attempt: () => Promise<T | 'drifted'>): Promise<T> {
  for (let i = 0; i < 2; i++) {
    const out = await attempt()
    if (out !== 'drifted') return out
  }
  throw mapStorageError(new UnitDriftError(name))
}

/**
 * `api_keys.create` (P1). The secret is made outside (`generateApiKey(env.randomBytes)`): only its hash and prefix reach the store, and the plaintext rides in the result only. Pure validation first (an expiry must be strictly
 * after the clock), then the agent in this organisation is read from the CRM database (`invalid_reference`: a key for another organisation's agent would authenticate as that agent). A disabled agent may be issued a key
 * ([[CORE27]]), but a form's principal may not ([[CHN423]]: `409 form_principal`, decided from that read, before any control write). An agent deleted between the read and the write leaves a key that fails closed at authentication ([[CORE350]] P1).
 */
async function createKey(
  port: ApiKeyStorePort,
  env: ControlEnv,
  input: z.infer<typeof createKeyBody>,
): Promise<IssuedKey> {
  const agentId = input.agent_id.toLowerCase()
  if (input.expires_at && new Date(input.expires_at).getTime() <= env.now.getTime())
    throw new ApiError(400, 'validation_error', 'expires_at must be in the future')
  const expiresAt = input.expires_at ? new Date(input.expires_at).toISOString() : null
  const secret = await generateApiKey(env.randomBytes)
  const agent = await env.read(readAgentForKey(env.organizationId, agentId))
  if (!agent) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
  if (agent.formId !== null)
    throw new ApiError(409, 'form_principal', `managed by form ${agent.formId}; change the form`)
  const id = env.newId()
  const now = env.now.toISOString()
  const made = await port.create({
    id,
    auditId: env.newId(),
    actorId: env.actor.id,
    organizationId: env.organizationId,
    agentId,
    keyHash: secret.hash,
    prefix: secret.prefix,
    expiresAt,
    now,
  })
  if (made === 'duplicate')
    throw new ApiError(409, 'conflict', 'the record changed while the operation was running; retry')
  return {
    id,
    organization_id: env.organizationId,
    agent_id: agentId,
    prefix: secret.prefix,
    last_used_at: null,
    revoked_at: null,
    expires_at: expiresAt,
    created_by: env.actor.id,
    created_at: now,
    updated_at: now,
    key: secret.key,
  }
}

async function getKey(port: ApiKeyStorePort, env: ControlEnv, rawId: string): Promise<ApiKeyRecord> {
  const found = UUID.test(rawId)
    ? await port.get({ id: rawId.toLowerCase(), organizationId: env.organizationId })
    : null
  if (!found) throw notFound()
  return recordOf(found)
}

/** `api_keys.revoke`: the store's guarded revoke (drift replanned once, then 409); an already revoked key returns unchanged with nothing written; an id not in control is 404. */
async function revokeKey(port: ApiKeyStorePort, env: ControlEnv, rawId: string): Promise<ApiKeyRecord> {
  if (!UUID.test(rawId)) throw notFound()
  const id = rawId.toLowerCase()
  return replanned('api_keys.revoke', async () => {
    const before = await port.get({ id, organizationId: env.organizationId })
    if (!before) throw notFound()
    const now = env.now.toISOString()
    const done = await port.revoke({
      id,
      organizationId: env.organizationId,
      auditId: env.newId(),
      actorId: env.actor.id,
      now,
      expectedUpdatedAt: before.updatedAt,
    })
    if (done === 'not_found') throw notFound()
    if (done === 'drifted') return 'drifted' as const
    // `already_revoked` while our read saw it live: a concurrent revoke landed first; replan so the answer is the revoked row (as the old unit's drift did).
    if (done === 'already_revoked') return before.revokedAt === null ? ('drifted' as const) : recordOf(before)
    return recordOf({ ...before, revokedAt: now, updatedAt: now })
  })
}

/** The store's filters for the parsed column conditions of a list: the pattern forms of `like` and `ilike` are finished here, so the store only compiles SQL. */
function storeFilters(conditions: Record<string, unknown>): ApiKeyStoreFilter[] {
  return Object.entries(conditions).map(([column, raw]) => {
    const c = raw as Condition
    const base = { column: column as ApiKeyStoreFilter['column'], not: c.not }
    switch (c.op) {
      case 'is':
        return { ...base, op: 'null' as const }
      case 'in':
        return { ...base, op: 'in' as const, value: (c.value as readonly unknown[]).map(String) }
      case 'like':
        return { ...base, op: 'glob' as const, value: globPattern(c.value as string) }
      case 'ilike':
        return { ...base, op: 'like' as const, value: likePattern(c.value as string) }
      default:
        return { ...base, op: c.op, value: String(c.value) }
    }
  })
}

/** `api_keys.list` (P3, P4): the control plane's keys only (P3); the sorts, orders, filters and cursors of the generic list, as keyset SQL in the store. */
async function listKeys(port: ApiKeyStorePort, env: ControlEnv, input: OperationInput) {
  const { after, limit, sort, order, ...filters } = input.query as Record<string, unknown>
  const q = prepareListQuery(apiKeys, { after, limit, sort, order, filters: filters as Record<string, string> })
  const rows = await port.list({
    organizationId: env.organizationId,
    filters: storeFilters(q.filters),
    ...(q.sort
      ? {
          sort: {
            column: q.sort.field as ApiKeyStoreSort['column'],
            order: q.sort.order,
            // every sortable column of a key is text (ids and timestamps): a cursor value is a string or null
            position: q.sort.position as ApiKeyStoreSort['position'],
          },
        }
      : q.after !== null
        ? { after: q.after }
        : {}),
    limit: q.limit + 1,
  })
  const page = rows.slice(0, q.limit).map(recordOf)
  const last = page[page.length - 1]
  const cursor = (): string => {
    if (!q.sort) return last!.id
    const value = q.sort.field === 'id' ? last!.id : ((last as Record<string, unknown>)[q.sort.field] as string | null)
    return encodeCursor(q.sort.field, q.sort.order, value, last!.id)
  }
  return { data: page, next_cursor: rows.length > q.limit ? cursor() : null }
}

/**
 * The four key operations on `/meta/v1` ([[CORE351]]): scopes `agents:write` (create, revoke) and `agents:read` (list, get), never proposable. `list` and `get` keep the request and response shapes of the generic resource they
 * replace, taken from its definition so the OpenAPI document does not move. The registry has them whatever the composition; one without a store answers `501 provider_not_configured`.
 */
export function apiKeyOperations(port: ApiKeyStorePort | null): ControlOperation[] {
  const store = (): ApiKeyStorePort => {
    if (!port) throw noStore()
    return port
  }
  const base = { kind: 'control' as const, surface: 'meta' as const, tags: ['api_keys'] }
  const [generatedList, generatedGet] = resourceOperations(apiKeys)
  if (generatedList?.kind !== 'tenant' || generatedGet?.kind !== 'tenant')
    throw new Error('api_keys: the generated list and get are missing')
  const shape = (op: typeof generatedList) => ({
    summary: op.summary,
    method: op.method,
    path: op.path,
    scope: op.scope!,
    validation: op.validation,
    ...(op.request ? { request: op.request } : {}),
    response: op.response,
  })
  return [
    { ...base, name: 'api_keys.list', ...shape(generatedList), run: (env, input) => listKeys(store(), env, input) },
    {
      ...base,
      name: 'api_keys.get',
      ...shape(generatedGet),
      run: (env, input) => getKey(store(), env, String((input.params as { id: string }).id)),
    },
    {
      ...base,
      name: 'api_keys.create',
      summary: 'Issue an API key for an agent; the key is shown once',
      description:
        "The key is returned once and never again. Issuing it is recorded in the audit log, not in the event feed: read it with audit.list (audit:read). 409 form_principal for the agent of a form (live or deleted): a form's agent holds no key; change the form instead.",
      method: 'post',
      path: '/api-keys',
      scope: { resource: 'agents', action: 'write' },
      validation: 'adapter',
      request: { body: createKeyBody },
      response: { status: 201, schema: apiKeyRecord.extend({ key: z.string() }) },
      run: (env, input) => createKey(store(), env, input.body as z.infer<typeof createKeyBody>),
    },
    {
      ...base,
      name: 'api_keys.revoke',
      summary: 'Revoke an API key',
      description:
        'Revoking is recorded in the audit log, not in the event feed: read it with audit.list (audit:read). Revoking a revoked key returns it unchanged.',
      method: 'post',
      path: '/api-keys/{id}/revoke',
      scope: { resource: 'agents', action: 'write' },
      validation: 'adapter',
      request: { params: idParams },
      response: { status: 200, schema: apiKeyRecord },
      run: (env, input) => revokeKey(store(), env, String((input.params as { id: string }).id)),
    },
  ]
}
