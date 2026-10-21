import type { Kysely, Transaction } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { ApiError } from '../errors.js'
import { lockKeys } from '../identity/locks.js'
import { AuthFailure, type AuthAdapter } from './adapter.js'
import type { Role } from './roles.js'

/**
 * A known user and, when the token names an organisation the vault already has, what its copy says: the
 * linked organisation's id and the user's most recently updated membership row there (live or soft-deleted;
 * [[CORE3]] D20). Both are null for first sight, which the caller re-resolves through repair.
 */
export type UserLogin = {
  userId: string
  linkedOrganizationId: string | null
  latestMembership: { role: Role; deletedAt: Date | null; updatedAt: Date } | null
}

async function findBySubject(
  trx: Transaction<Database>,
  provider: string,
  subject: string,
  organizationExternalId: string | null,
): Promise<UserLogin | null> {
  const user = await trx
    .selectFrom('users')
    .select('id')
    .where('auth_provider', '=', provider)
    .where('auth_subject', '=', subject)
    .executeTakeFirst()
  if (!user) return null
  const login: UserLogin = { userId: user.id, linkedOrganizationId: null, latestMembership: null }
  if (organizationExternalId === null) return login
  const org = await trx
    .selectFrom('organizations')
    .select('id')
    .where('auth_provider', '=', provider)
    .where('auth_org_id', '=', organizationExternalId)
    .executeTakeFirst()
  if (!org) return login
  const latest = await trx
    .selectFrom('memberships')
    .select(['role', 'deleted_at', 'updated_at'])
    .where('organization_id', '=', org.id)
    .where('user_id', '=', user.id)
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  return {
    ...login,
    linkedOrganizationId: org.id,
    latestMembership: latest ? { role: latest.role as Role, deletedAt: latest.deleted_at, updatedAt: latest.updated_at } : null,
  }
}

/** The steady-state lookup: one service-role transaction of SELECTs only. */
export function lookupUser(
  db: Kysely<Database>,
  provider: string,
  subject: string,
  organizationExternalId: string | null,
): Promise<UserLogin | null> {
  return withServiceRole(db, (trx) => findBySubject(trx, provider, subject, organizationExternalId))
}

const accountConflict = () => new ApiError(409, 'account_conflict', 'this email belongs to another account')

/**
 * First sight of a subject ([[CORE3]] D4, D5, D12): one profile fetch outside any transaction, then a locked
 * find-or-create. Identity bookkeeping emits no event (named exception to invariant 5). Throws, never
 * catches, inside the transaction (invariant 3).
 */
export async function provisionUser(db: Kysely<Database>, adapter: AuthAdapter, subject: string): Promise<UserLogin> {
  const profile = await adapter.fetchProfile(subject)
  const email = profile.email?.trim()
  if (!email) {
    console.warn('[auth] first sight: provider returned no email', { provider: adapter.provider })
    throw new AuthFailure('no_email', 'account has no email address')
  }
  const provider = adapter.provider

  return withServiceRole(db, async (trx) => {
    await lockKeys(trx, [`auth-subject:${provider}:${subject}`, `user-email:${email.toLowerCase()}`])

    const existing = await findBySubject(trx, provider, subject, null)
    if (existing) return existing

    const taken = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
    if (taken) {
      console.warn('[auth] account_conflict', { provider })
      throw accountConflict()
    }

    const principal = await trx.insertInto('principals').values({ kind: 'user' }).returning('id').executeTakeFirstOrThrow()
    const user = await trx
      .insertInto('users')
      .values({
        id: principal.id,
        email,
        name: profile.name,
        email_verified: profile.emailVerified,
        auth_provider: provider,
        auth_subject: subject,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst()
    // Thrown so the transaction, and the principal row above, roll back.
    if (!user) throw accountConflict()
    return { userId: user.id, linkedOrganizationId: null, latestMembership: null }
  })
}
