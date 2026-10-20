import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createApiKey } from './auth/api-keys.js'
import { assertAgentGrantable, grantableScopes } from './auth/roles.js'
import { createVaultRegistry } from './operations.js'
import { ScopeSet } from './scopes.js'

/**
 * Mints a first organisation, an owner user (reused if the email exists) and an agent with an API key.
 * A development and ops tool: it emits no events (a named exception to invariant 5; the directory sync
 * ([[CORE3]]) is the event-emitting path for organisations and memberships). With `authSubject` it also links the user's login ([[CORE3]] D5): the operator
 * re-link, and the sign-in path for a bootstrapped member.
 */
export async function bootstrap(
  db: Kysely<Database>,
  opts: {
    organizationName: string
    email: string
    userName?: string
    agentName: string
    scopes?: readonly string[]
    /** Defaults to 'clerk' when `authSubject` is given. */
    authProvider?: string
    authSubject?: string
  },
): Promise<{ organizationId: string; userId: string; agentId: string; apiKeyId: string; key: string }> {
  const declared = createVaultRegistry().declaredScopes()
  const scopes = opts.scopes ? ScopeSet.parse(opts.scopes).toStrings() : grantableScopes(declared)
  for (const s of scopes) if (!declared.includes(s)) throw new Error(`unknown scope: ${s}`)
  assertAgentGrantable(scopes, declared)
  const authProvider = opts.authSubject !== undefined ? (opts.authProvider ?? 'clerk') : undefined
  const authSubject = opts.authSubject

  return withServiceRole(db, async (trx) => {
    const findUser = () =>
      trx.selectFrom('users').select(['id', 'auth_provider', 'auth_subject']).where('email', '=', opts.email).executeTakeFirst()
    let user = await findUser()

    if (authProvider !== undefined && authSubject !== undefined) {
      const holder = await trx
        .selectFrom('users')
        .select('id')
        .where('auth_provider', '=', authProvider)
        .where('auth_subject', '=', authSubject)
        .executeTakeFirst()
      if (holder && holder.id !== user?.id) throw new Error(`login ${authProvider}:${authSubject} belongs to another user`)
      if (user && user.auth_subject !== null && (user.auth_provider !== authProvider || user.auth_subject !== authSubject)) {
        throw new Error(`user ${opts.email} is linked to another login`)
      }
    }

    const org = await trx.insertInto('organizations').values({ name: opts.organizationName }).returning('id').executeTakeFirstOrThrow()

    if (!user) {
      const principal = await trx.insertInto('principals').values({ kind: 'user' }).returning('id').executeTakeFirstOrThrow()
      // ON CONFLICT, never catching 23505 inside a transaction (invariant 3).
      user =
        (await trx
          .insertInto('users')
          .values({
            id: principal.id,
            email: opts.email,
            name: opts.userName ?? null,
            auth_provider: authProvider ?? null,
            auth_subject: authSubject ?? null,
          })
          .onConflict((oc) => oc.column('email').doNothing())
          .returning(['id', 'auth_provider', 'auth_subject'])
          .executeTakeFirst()) ?? (await findUser())
    } else if (authProvider !== undefined && user.auth_subject === null) {
      await trx.updateTable('users').set({ auth_provider: authProvider, auth_subject: authSubject! }).where('id', '=', user.id).execute()
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
