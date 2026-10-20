import type { Kysely, Selectable, Transaction } from 'kysely'
import { sql } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { membershipRecord, organizationRecord } from '../account/organizations.js'
import { ApiError } from '../errors.js'
import { directoryOrgKey, lockKeys } from '../identity/locks.js'
import { writeEvent } from '../outbox.js'
import { AuthFailure, type AuthAdapter, type DirectoryOrganization } from '../auth/adapter.js'
import { provisionUser } from '../auth/first-sight.js'
import type { Role } from '../auth/roles.js'
import { systemPrincipalId } from './system-principal.js'

// The directory sync ([[CORE3]] D1, D18, D20, D21): Clerk is the source of truth, the vault keeps a copy.
// Network calls happen first, outside any transaction; each write is one service-role transaction under the
// provider organisation's advisory lock, attributed to the system principal, emitting its events (D22).

export type ReconcileSummary = { organizationId: string | null; created: number; updated: number; deleted: number }

type OrgRow = Selectable<Database['organizations']>
type MembershipRow = Selectable<Database['memberships']>

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d)
const orgRecord = (r: OrgRow) =>
  organizationRecord.parse({ id: r.id, name: r.name, created_at: iso(r.created_at), updated_at: iso(r.updated_at) })
const memberRecord = (r: MembershipRow) =>
  membershipRecord.parse({
    id: r.id,
    organization_id: r.organization_id,
    user_id: r.user_id,
    role: r.role,
    created_by: r.created_by,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  })

/** Writes in one transaction as the system principal; the principal is only created when a first event needs it. */
function directoryWriter(trx: Transaction<Database>) {
  let system: Promise<string> | undefined
  const actor = () => (system ??= systemPrincipalId(trx))
  return {
    actor,
    async emit(
      organizationId: string,
      type: string,
      resourceType: 'organization' | 'membership',
      resourceId: string,
      before: Record<string, unknown> | null,
      after: Record<string, unknown> | null,
    ) {
      await writeEvent(trx, { organizationId, actorId: await actor(), type, resourceType, resourceId, before, after })
    },
  }
}

const findOrganization = (trx: Transaction<Database>, provider: string, externalId: string) =>
  trx.selectFrom('organizations').selectAll().where('auth_provider', '=', provider).where('auth_org_id', '=', externalId).executeTakeFirst()

/**
 * Makes the copy agree with a verified token claim for one user ([[CORE3]] D20): creates the organisation
 * from the provider if the vault has never seen it, then inserts or re-roles this user's live membership.
 * Never deletes and never renames. Returns the vault organisation id.
 */
export async function repairMembership(
  db: Kysely<Database>,
  adapter: AuthAdapter,
  args: { userId: string; externalId: string; role: Role; known: { organizationId: string | null } },
): Promise<string> {
  const { userId, externalId, role } = args
  const provider = adapter.provider
  let fetched: DirectoryOrganization | null = null
  if (args.known.organizationId === null) {
    fetched = await adapter.fetchOrganization(externalId)
    // The token is at most a minute stale; a copy of a deleted organisation is worse than a refusal (P6).
    if (fetched === null) throw new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
  }

  return withServiceRole(db, async (trx) => {
    await lockKeys(trx, [directoryOrgKey(provider, externalId)])
    const w = directoryWriter(trx)

    let org = await findOrganization(trx, provider, externalId)
    if (!org) {
      if (fetched === null) throw new Error('directory: a linked organisation disappeared during repair')
      const inserted = await trx
        .insertInto('organizations')
        .values({ name: fetched.name, auth_provider: provider, auth_org_id: externalId })
        .onConflict((oc) => oc.constraint('organizations_auth_provider_org_key').doNothing())
        .returningAll()
        .executeTakeFirst()
      org = inserted ?? (await findOrganization(trx, provider, externalId))
      if (!org) throw new Error('directory: organisation insert lost its row')
      if (inserted) await w.emit(org.id, 'organization.created', 'organization', org.id, null, orgRecord(org))
    }

    const live = await trx
      .selectFrom('memberships')
      .selectAll()
      .where('organization_id', '=', org.id)
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!live) {
      const inserted = await trx
        .insertInto('memberships')
        .values({ organization_id: org.id, user_id: userId, role, created_by: await w.actor() })
        .onConflict((oc) => oc.columns(['organization_id', 'user_id']).where('deleted_at', 'is', null).doNothing())
        .returningAll()
        .executeTakeFirst()
      if (inserted) await w.emit(org.id, 'membership.created', 'membership', inserted.id, null, memberRecord(inserted))
    } else if (live.role !== role) {
      const updated = await trx
        .updateTable('memberships')
        .set({ role })
        .where('id', '=', live.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      await w.emit(org.id, 'membership.updated', 'membership', live.id, memberRecord(live), memberRecord(updated))
    }
    return org.id
  })
}

/**
 * Reads one provider organisation and brings the copy to match ([[CORE3]] "Directory sync"): organisation row
 * (created or renamed), then every membership inserted, re-roled or soft-deleted. Idempotent: a second run
 * with nothing changed upstream writes nothing and emits nothing.
 */
export async function reconcileOrganization(db: Kysely<Database>, adapter: AuthAdapter, externalId: string): Promise<ReconcileSummary> {
  const provider = adapter.provider
  // 1. Network first.
  const organization = await adapter.fetchOrganization(externalId)
  const members = organization ? await adapter.listMembers(externalId) : []

  // 2. Provision members the vault has never seen, one transaction each. A conflict skips that member; the
  // catch is out here because provisionUser's own transaction has already rolled back (invariant 3).
  if (members.length > 0) {
    const subjects = members.map((m) => m.subject)
    const known = await withServiceRole(db, (trx) =>
      trx.selectFrom('users').select('auth_subject').where('auth_provider', '=', provider).where('auth_subject', 'in', subjects).execute(),
    )
    const have = new Set(known.map((u) => u.auth_subject))
    for (const subject of subjects) {
      if (have.has(subject)) continue
      try {
        await provisionUser(db, adapter, subject)
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          console.warn('[directory] member skipped', { reason: 'account_conflict' })
        } else if (err instanceof AuthFailure) {
          console.warn('[directory] member skipped', { reason: 'no_email' })
        } else throw err
      }
    }
  }

  // 3. One transaction under the organisation's lock.
  return withServiceRole(db, async (trx) => {
    await lockKeys(trx, [directoryOrgKey(provider, externalId)])
    const w = directoryWriter(trx)
    const summary: ReconcileSummary = { organizationId: null, created: 0, updated: 0, deleted: 0 }

    let org = await findOrganization(trx, provider, externalId)
    if (organization === null) {
      if (!org) return summary
      summary.organizationId = org.id
    } else {
      if (!org) {
        org = await trx
          .insertInto('organizations')
          .values({ name: organization.name, auth_provider: provider, auth_org_id: externalId })
          .returningAll()
          .executeTakeFirstOrThrow()
        await w.emit(org.id, 'organization.created', 'organization', org.id, null, orgRecord(org))
      } else if (org.name !== organization.name) {
        const renamed = await trx
          .updateTable('organizations')
          .set({ name: organization.name })
          .where('id', '=', org.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        await w.emit(org.id, 'organization.updated', 'organization', org.id, orgRecord(org), orgRecord(renamed))
        org = renamed
      }
      summary.organizationId = org.id
    }

    const wanted = new Map(members.map((m) => [m.subject, m.role]))
    const live = await trx
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .selectAll('memberships')
      .select('users.auth_subject as subject')
      .where('memberships.organization_id', '=', org.id)
      .where('memberships.deleted_at', 'is', null)
      .orderBy('memberships.id')
      .execute()
    const liveBySubject = new Map(live.map((m) => [m.subject, m]))

    // Soft-delete what Clerk no longer lists (all of it when the organisation is gone).
    for (const row of live) {
      if (row.subject !== null && wanted.has(row.subject)) continue
      const { subject: _subject, ...before } = row
      await trx
        .updateTable('memberships')
        .set({ deleted_at: sql`now()` })
        .where('id', '=', row.id)
        .execute()
      await w.emit(org.id, 'membership.deleted', 'membership', row.id, memberRecord(before), null)
      summary.deleted++
    }

    if (wanted.size > 0) {
      const users = await trx
        .selectFrom('users')
        .select(['id', 'auth_subject'])
        .where('auth_provider', '=', provider)
        .where('auth_subject', 'in', [...wanted.keys()])
        .execute()
      const idBySubject = new Map(users.map((u) => [u.auth_subject, u.id]))
      for (const [subject, role] of wanted) {
        const userId = idBySubject.get(subject)
        if (!userId) continue // skipped above (conflict or no email)
        const existing = liveBySubject.get(subject)
        if (!existing) {
          const created = await trx
            .insertInto('memberships')
            .values({ organization_id: org.id, user_id: userId, role, created_by: await w.actor() })
            .returningAll()
            .executeTakeFirstOrThrow()
          await w.emit(org.id, 'membership.created', 'membership', created.id, null, memberRecord(created))
          summary.created++
        } else if (existing.role !== role) {
          const { subject: _subject, ...before } = existing
          const updated = await trx
            .updateTable('memberships')
            .set({ role })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
          await w.emit(org.id, 'membership.updated', 'membership', existing.id, memberRecord(before), memberRecord(updated))
          summary.updated++
        }
      }
    }
    return summary
  })
}

/**
 * Refreshes a known user's email, name and verification from the provider ([[CORE3]] D12: no event). Never
 * creates a user and never moves an email onto a second account.
 */
export async function refreshUser(
  db: Kysely<Database>,
  adapter: AuthAdapter,
  subject: string,
): Promise<'updated' | 'unchanged' | 'unknown' | 'conflict'> {
  const provider = adapter.provider
  const known = await withServiceRole(db, (trx) =>
    trx.selectFrom('users').select('id').where('auth_provider', '=', provider).where('auth_subject', '=', subject).executeTakeFirst(),
  )
  if (!known) return 'unknown'

  const profile = await adapter.fetchProfile(subject)
  const email = profile.email?.trim()
  if (!email) {
    console.warn('[directory] user refresh: provider returned no email', { provider })
    return 'unchanged'
  }

  return withServiceRole(db, async (trx) => {
    await lockKeys(trx, [`auth-subject:${provider}:${subject}`, `user-email:${email.toLowerCase()}`])
    const current = await trx
      .selectFrom('users')
      .select(['id', 'email', 'name', 'email_verified'])
      .where('auth_provider', '=', provider)
      .where('auth_subject', '=', subject)
      .executeTakeFirst()
    if (!current) return 'unknown'
    const owner = await trx.selectFrom('users').select('id').where('email', '=', email).where('id', '<>', current.id).executeTakeFirst()
    if (owner) {
      console.warn('[directory] user refresh: email belongs to another account', { provider })
      return 'conflict'
    }
    if (current.email.toLowerCase() === email.toLowerCase() && current.name === profile.name && current.email_verified === profile.emailVerified) {
      return 'unchanged'
    }
    await trx
      .updateTable('users')
      .set({ email, name: profile.name, email_verified: profile.emailVerified })
      .where('id', '=', current.id)
      .execute()
    return 'updated'
  })
}
