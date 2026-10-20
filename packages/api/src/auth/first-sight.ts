import { sql, type Kysely, type Transaction } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { ApiError } from '../errors.js'
import type { AuthAdapter } from './adapter.js'
import { AuthFailure } from './user-authenticator.js'

export type UserLogin = { userId: string; memberships: { organizationId: string; role: 'owner' | 'member' }[] }

async function liveMemberships(trx: Transaction<Database>, userId: string): Promise<UserLogin['memberships']> {
  const rows = await trx
    .selectFrom('memberships')
    .select(['organization_id', 'role'])
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .execute()
  return rows.map((r) => ({ organizationId: r.organization_id, role: r.role as 'owner' | 'member' }))
}

async function findBySubject(trx: Transaction<Database>, provider: string, subject: string): Promise<UserLogin | null> {
  const user = await trx
    .selectFrom('users')
    .select('id')
    .where('auth_provider', '=', provider)
    .where('auth_subject', '=', subject)
    .executeTakeFirst()
  return user ? { userId: user.id, memberships: await liveMemberships(trx, user.id) } : null
}

/** The steady-state lookup: one service-role transaction of SELECTs only. */
export function lookupUser(db: Kysely<Database>, provider: string, subject: string): Promise<UserLogin | null> {
  return withServiceRole(db, (trx) => findBySubject(trx, provider, subject))
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
    await sql`
      SELECT pg_advisory_xact_lock(k) FROM (
        SELECT DISTINCT hashtextextended(key, 0) AS k
        FROM unnest(${[`auth-subject:${provider}:${subject}`, `user-email:${email.toLowerCase()}`]}::text[]) AS t(key)
        ORDER BY k
      ) AS s`.execute(trx)

    const existing = await findBySubject(trx, provider, subject)
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
    return { userId: user.id, memberships: [] }
  })
}
