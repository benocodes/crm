import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createApiKey } from './auth/api-keys.js'
import { createVaultRegistry } from './operations.js'
import { ScopeSet } from './scopes.js'

/**
 * Mints a first organisation, an owner user (reused if the email exists) and an agent with an API key.
 * A development and ops tool: it emits no events (a named exception to invariant 5; [[CORE3]]'s
 * `organizations.create` is the event-emitting path).
 */
export async function bootstrap(
  db: Kysely<Database>,
  opts: {
    organizationName: string
    email: string
    userName?: string
    agentName: string
    scopes?: readonly string[]
  },
): Promise<{ organizationId: string; userId: string; agentId: string; apiKeyId: string; key: string }> {
  const declared = createVaultRegistry().declaredScopes()
  const scopes = opts.scopes ? ScopeSet.parse(opts.scopes).toStrings() : declared
  for (const s of scopes) if (!declared.includes(s)) throw new Error(`unknown scope: ${s}`)

  return withServiceRole(db, async (trx) => {
    const org = await trx.insertInto('organizations').values({ name: opts.organizationName }).returning('id').executeTakeFirstOrThrow()

    const findUser = () => trx.selectFrom('users').select('id').where('email', '=', opts.email).executeTakeFirst()
    let user = await findUser()
    if (!user) {
      const principal = await trx.insertInto('principals').values({ kind: 'user' }).returning('id').executeTakeFirstOrThrow()
      // ON CONFLICT, never catching 23505 inside a transaction (invariant 3).
      user =
        (await trx
          .insertInto('users')
          .values({ id: principal.id, email: opts.email, name: opts.userName ?? null })
          .onConflict((oc) => oc.column('email').doNothing())
          .returning('id')
          .executeTakeFirst()) ?? (await findUser())
    }
    const userId = user!.id

    await trx.insertInto('memberships').values({ organization_id: org.id, user_id: userId, role: 'owner', created_by: userId }).execute()

    const principal = await trx.insertInto('principals').values({ kind: 'agent' }).returning('id').executeTakeFirstOrThrow()
    await trx
      .insertInto('agents')
      .values({ id: principal.id, organization_id: org.id, name: opts.agentName, scopes, created_by: userId })
      .execute()
    const apiKey = await createApiKey(trx, { organizationId: org.id, agentId: principal.id, createdBy: userId })
    return { organizationId: org.id, userId, agentId: principal.id, apiKeyId: apiKey.id, key: apiKey.key }
  })
}
