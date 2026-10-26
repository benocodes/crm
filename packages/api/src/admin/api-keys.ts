import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, bind, codecs, defineOperation, readMaybe, step, ts, unit, type PreparedOperation } from '@vault/storage'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { apiKeys, type ApiKeyRecord } from '../resources/api-keys.js'
import { beforeRead, columnsOf, receipt, resultStep, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import { canonicalId } from '../storage/prepare.js'

export type IssuedKey = ApiKeyRecord & { key: string }

/**
 * `api_keys.create` ([[CORE40]] P7). The secret is made outside (`generateApiKey(env.randomBytes)`): only its hash and
 * prefix reach a statement, and the plaintext rides in the result only. Pure validation first (an expiry must be
 * strictly after the unit's clock), then the plan read of the agent in this organisation (`invalid_reference`: the
 * foreign key is plain and Postgres checks it without RLS, so a key for another organisation's agent would
 * authenticate as that agent), then `INSERT ... SELECT ... WHERE EXISTS (agent)` as the commit-time form of the same
 * predicate. A disabled agent may be issued a key ([[CORE27]]).
 */
export function issueApiKeyOperation(
  env: PreparedEnv,
  input: { agent_id: string; expires_at?: string | null },
  secret: { key: string; hash: string; prefix: string },
): PreparedOperation<IssuedKey> {
  const agentId = input.agent_id.toLowerCase()
  if (input.expires_at && new Date(input.expires_at).getTime() <= env.now.getTime()) {
    throw new ApiError(400, 'validation_error', 'expires_at must be in the future')
  }
  const expiresAt = input.expires_at ? codecs.timestamp.write(input.expires_at) : null
  const id = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<IssuedKey>({
    name: 'api_keys.create',
    mutates: true,
    reads: (qc) => ({
      agent: readMaybe(qc.db.selectFrom('agents').select('agents.id').where('agents.id', '=', agentId).where('agents.organization_id', '=', env.organizationId)),
    }),
    build: (found, qc) => {
      if (!found.maybe('agent')) throw new ApiError(400, 'invalid_reference', 'a referenced record does not exist')
      const agentExists = sql<SqlBool>`exists (select 1 from "agents" where "agents"."id" = ${agentId} and "agents"."organization_id" = ${env.organizationId})`
      const insert = qc.db
        .insertInto('api_keys')
        .columns(['id', 'created_at', 'updated_at', 'organization_id', 'agent_id', 'key_hash', 'prefix', 'last_used_at', 'revoked_at', 'expires_at', 'created_by'])
        .expression(
          qc.db
            .selectNoFrom([
              bind(qc, 'uuid', id).as('id'),
              bind(qc, 'timestamp', at).as('created_at'),
              bind(qc, 'timestamp', at).as('updated_at'),
              bind(qc, 'uuid', env.organizationId).as('organization_id'),
              bind(qc, 'uuid', agentId).as('agent_id'),
              bind(qc, 'text', secret.hash).as('key_hash'),
              bind(qc, 'text', secret.prefix).as('prefix'),
              bind(qc, 'timestamp', null).as('last_used_at'),
              bind(qc, 'timestamp', null).as('revoked_at'),
              bind(qc, 'timestamp', expiresAt).as('expires_at'),
              bind(qc, 'uuid', env.actor.id).as('created_by'),
            ])
            .where(agentExists),
        )
      return unit({
        steps: [
          step(insert, 'first-mutation', { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'api_key.created',
              resourceType: 'api_key',
              resourceId: id,
              before: null,
              // the record's columns only: never key_hash (D10)
              after: { table: 'api_keys', columns: columnsOf(apiKeys) },
            }),
            'first-event',
          ),
          resultStep(apiKeys, qc, env, id, eventId),
        ],
        events: [receipt(apiKeys, eventId, 'created', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('api_keys.create')
          return { ...toRecord(apiKeys, rows[0]!), key: secret.key }
        },
      })
    },
  })
}

/**
 * `api_keys.revoke` ([[CORE40]] P7). The plan reads the key with its stamp. An already revoked key returns unchanged
 * with no statement and no event. Otherwise one update guarded on `revoked_at IS NULL` and the stamp (the stamp is
 * what catches a racing writer on D1, the null guard states the rule), then `api_key.revoked` and the gated result.
 * `revoked_at` and `updated_at` are both the unit's clock (D2).
 */
export function revokeApiKeyOperation(env: PreparedEnv, rawId: string): PreparedOperation<ApiKeyRecord> {
  const id = canonicalId(apiKeys, rawId)
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  const notFound = () => new ApiError(404, 'not_found', 'api_key not found')
  return defineOperation<ApiKeyRecord>({
    name: 'api_keys.revoke',
    mutates: true,
    reads: (qc) => ({ before: beforeRead(apiKeys, qc, env, id) }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (!row) throw notFound()
      const { __stamp, ...rest } = row as Record<string, unknown>
      const before = toRecord(apiKeys, rest)
      if (before.revoked_at) return unit({ steps: [], events: [], decode: () => before })
      const update = qc.db
        .updateTable('api_keys')
        .set({ revoked_at: at, updated_at: at })
        .where('api_keys.id', '=', id)
        .where('api_keys.organization_id', '=', env.organizationId)
        .where('api_keys.revoked_at', 'is', null)
        .where(sql<SqlBool>`${ts.exact(qc, 'api_keys.updated_at')} = ${String(__stamp)}`)
      return unit({
        steps: [
          step(update, 'first-mutation', { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'api_key.revoked',
              resourceType: 'api_key',
              resourceId: id,
              before,
              after: { table: 'api_keys', columns: columnsOf(apiKeys) },
            }),
            'first-event',
          ),
          resultStep(apiKeys, qc, env, id, eventId),
        ],
        events: [receipt(apiKeys, eventId, 'revoked', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('api_keys.revoke')
          return toRecord(apiKeys, rows[0]!)
        },
      })
    },
  })
}

