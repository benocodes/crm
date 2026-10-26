import { sql } from 'kysely'
import { createApiKey } from '../auth/api-keys.js'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'
import { apiKeys, type ApiKeyRecord } from '../resources/api-keys.js'
import { emitResourceEvent, getResource } from '../resources/crud.js'
import { readColumns, toRecord } from '../resources/define.js'

/**
 * Issues a key for an agent of this organisation. The agent is checked with a SELECT under RLS: the foreign
 * key is plain and Postgres checks it without RLS, so a key for another organisation's agent would
 * authenticate as that agent (P6). The plaintext is in the return value only; the event carries the record.
 */
export async function issueApiKey(
  ctx: ServiceContext,
  input: { agent_id: string; expires_at?: string | null },
): Promise<ApiKeyRecord & { key: string }> {
  const expiresAt = input.expires_at ? new Date(input.expires_at) : null
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'validation_error', 'expires_at must be in the future')
  }
  const agent = await ctx.trx.selectFrom('agents').select('id').where('id', '=', input.agent_id).executeTakeFirst()
  if (!agent) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
  const { id, key } = await createApiKey(ctx.trx, {
    organizationId: ctx.organizationId,
    agentId: agent.id,
    createdBy: ctx.actor.id,
    expiresAt,
  })
  const record = await getResource(ctx, apiKeys, id)
  await emitResourceEvent(ctx, apiKeys, 'created', null, record, id)
  return { ...record, key }
}

/** Revokes a key; revoking a revoked key returns it unchanged with no event. */
export async function revokeApiKey(ctx: ServiceContext, id: string): Promise<ApiKeyRecord> {
  const row = await ctx.trx
    .selectFrom('api_keys')
    .select(readColumns(apiKeys) as never)
    .where('id', '=', id.toLowerCase())
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new ApiError(404, 'not_found', 'api_key not found')
  const before = toRecord(apiKeys, row as Record<string, unknown>)
  if (before.revoked_at) return before
  const updated = await ctx.trx
    .updateTable('api_keys')
    .set({ revoked_at: sql`now()` })
    .where('id', '=', before.id)
    .returning(readColumns(apiKeys) as never)
    .executeTakeFirstOrThrow()
  const after = toRecord(apiKeys, updated as Record<string, unknown>)
  await emitResourceEvent(ctx, apiKeys, 'revoked', before, after, before.id)
  return after
}

// RED-PHASE STUBS (CORE40 Phase 1): replaced by the real programs in Phase 3.
import type { PreparedOperation } from '@vault/storage'
import type { PreparedEnv } from '../storage/definition.js'
export type IssuedKey = ApiKeyRecord & { key: string }
export function issueApiKeyOperation(_env: PreparedEnv, _input: { agent_id: string; expires_at?: string | null }, _secret: { key: string; hash: string; prefix: string }): PreparedOperation<IssuedKey> {
  throw new Error('not implemented')
}
export function revokeApiKeyOperation(_env: PreparedEnv, _id: string): PreparedOperation<ApiKeyRecord> {
  throw new Error('not implemented')
}
