import { sql, type Kysely, type Transaction } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { ScopeSet } from '../scopes.js'
import type { Principal } from './types.js'

export const API_KEY_PREFIX = 'vk_'

// Web Crypto only (no node:crypto), so the same code runs in workerd.
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** SHA-256, lowercase hex. High-entropy keys need no slow hash. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateApiKey(): Promise<{ key: string; hash: string; prefix: string }> {
  const key = API_KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)))
  return { key, hash: await hashApiKey(key), prefix: key.slice(0, 11) }
}

/** Inserts the key row. The plaintext exists only in this return value. */
export async function createApiKey(
  trx: Transaction<Database>,
  args: { organizationId: string; agentId: string; createdBy: string; expiresAt?: Date | null },
): Promise<{ id: string; key: string; prefix: string }> {
  const { key, hash, prefix } = await generateApiKey()
  const row = await trx
    .insertInto('api_keys')
    .values({
      organization_id: args.organizationId,
      agent_id: args.agentId,
      key_hash: hash,
      prefix,
      expires_at: args.expiresAt ?? null,
      created_by: args.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, key, prefix }
}

/**
 * Looks the key up and (at most once a minute per key) records its use, in one service-role
 * transaction. Unknown, revoked, expired and disabled-agent keys are all `null`.
 */
export async function authenticateApiKey(db: Kysely<Database>, key: string): Promise<Principal | null> {
  const hash = await hashApiKey(key)
  return withServiceRole(db, async (trx) => {
    const row = await trx
      .selectFrom('api_keys')
      .innerJoin('agents', 'agents.id', 'api_keys.agent_id')
      .select(['api_keys.id as key_id', 'agents.id as agent_id', 'agents.organization_id', 'agents.scopes'])
      .where('api_keys.key_hash', '=', hash)
      .where('api_keys.revoked_at', 'is', null)
      .where((eb) => eb.or([eb('api_keys.expires_at', 'is', null), eb('api_keys.expires_at', '>', sql<Date>`now()`)]))
      .where('agents.disabled_at', 'is', null)
      .executeTakeFirst()
    if (!row) return null
    await trx
      .updateTable('api_keys')
      .set({ last_used_at: sql`now()` })
      .where('id', '=', row.key_id)
      .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', sql<Date>`now() - interval '60 seconds'`)]))
      .execute()
    return {
      actor: { id: row.agent_id, kind: 'agent' as const },
      organizationId: row.organization_id,
      scopes: ScopeSet.parse(row.scopes),
    }
  })
}
