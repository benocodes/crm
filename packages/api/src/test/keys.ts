import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createApiKey } from '../auth/api-keys.js'

/** Test helper: mints a key for an agent. `revoked` sets `revoked_at = now()` after creation. */
export async function seedApiKey(
  db: Kysely<Database>,
  args: { organizationId: string; agentId: string; createdBy: string; expiresAt?: Date | null; revoked?: boolean },
): Promise<{ id: string; key: string }> {
  return withServiceRole(db, async (trx) => {
    const { id, key } = await createApiKey(trx, args)
    if (args.revoked) await trx.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', id).execute()
    return { id, key }
  })
}
