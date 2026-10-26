import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { generateApiKey } from '../auth/api-keys.js'

/**
 * Test seed: mints a key for an agent with a direct insert under the service role (the production path is `api_keys.create`;
 * a seed must not depend on it). `revoked` stamps `revoked_at` at the same time.
 */
export async function seedApiKey(
  db: Kysely<Database>,
  args: { organizationId: string; agentId: string; createdBy: string; expiresAt?: Date | null; revoked?: boolean },
): Promise<{ id: string; key: string }> {
  const { key, hash, prefix } = await generateApiKey((n) => crypto.getRandomValues(new Uint8Array(n)))
  return withServiceRole(db, async (trx) => {
    const row = await trx
      .insertInto('api_keys')
      .values({
        organization_id: args.organizationId,
        agent_id: args.agentId,
        key_hash: hash,
        prefix,
        expires_at: args.expiresAt ?? null,
        revoked_at: args.revoked ? new Date() : null,
        created_by: args.createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { id: row.id, key }
  })
}
