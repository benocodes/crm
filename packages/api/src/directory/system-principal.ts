import type { Transaction } from 'kysely'
import type { Database } from '@vault/db'

/**
 * The one `system` principal that directory writes are attributed to ([[CORE3]] D22). Created on first use
 * rather than seeded, so it survives a test truncate and needs no seed anywhere. `ON CONFLICT DO NOTHING`
 * (never a caught 23505: invariant 3) makes concurrent first uses safe.
 */
export async function systemPrincipalId(trx: Transaction<Database>): Promise<string> {
  await trx
    .insertInto('principals')
    .values({ kind: 'system' })
    .onConflict((oc) => oc.column('kind').where('kind', '=', 'system').doNothing())
    .execute()
  const row = await trx.selectFrom('principals').select('id').where('kind', '=', 'system').executeTakeFirstOrThrow()
  return row.id
}
