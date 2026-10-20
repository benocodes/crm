import { sql } from 'kysely'
import type { AccountContext } from '../context.js'
import { ApiError } from '../errors.js'
import { invitationRecord, type InvitationRecord } from '../resources/invitations.js'
import { membershipRecord, type MembershipRecord } from './organizations.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d)
const dated = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, iso(v)]))

const INVITATION_COLUMNS = ['id', 'organization_id', 'email', 'role', 'expires_at', 'accepted_at', 'accepted_by', 'created_by', 'created_at', 'updated_at'] as const
const MEMBERSHIP_COLUMNS = ['id', 'organization_id', 'user_id', 'role', 'created_by', 'created_at', 'updated_at'] as const

/**
 * The caller accepts an invitation addressed to their verified email and becomes a member
 * ([[CORE3]] D10). Runs on the service role; the locked invitation row serialises replays and races.
 */
export async function acceptInvitation(ctx: AccountContext, rawId: string): Promise<MembershipRecord> {
  const notFound = () => new ApiError(404, 'not_found', 'invitation not found')
  const id = rawId.toLowerCase()
  if (!UUID.test(id)) throw new ApiError(400, 'validation_error', 'id must be a UUID')

  const user = await ctx.trx
    .selectFrom('users')
    .select(['id', 'email', 'email_verified'])
    .where('id', '=', ctx.actor.id)
    .executeTakeFirstOrThrow()
  const inv = await ctx.trx
    .selectFrom('invitations')
    .select([...INVITATION_COLUMNS, 'deleted_at', sql<boolean>`expires_at <= now()`.as('expired')])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!inv || inv.deleted_at) throw notFound()
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw notFound()
  if (!user.email_verified) {
    throw new ApiError(403, 'email_unverified', 'verify your email address to accept an invitation')
  }

  const liveMembership = () =>
    ctx.trx
      .selectFrom('memberships')
      .select([...MEMBERSHIP_COLUMNS])
      .where('organization_id', '=', inv.organization_id)
      .where('user_id', '=', user.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()

  if (inv.accepted_at) {
    // A replay by the same person who is still a member; anything else is gone.
    const existing = inv.accepted_by === user.id ? await liveMembership() : undefined
    if (!existing) throw notFound()
    return membershipRecord.parse(dated(existing))
  }
  if (inv.expired) throw notFound()

  const inserted = await ctx.trx
    .insertInto('memberships')
    .values({ organization_id: inv.organization_id, user_id: user.id, role: inv.role as 'owner' | 'member', created_by: user.id })
    .onConflict((oc) => oc.columns(['organization_id', 'user_id']).where('deleted_at', 'is', null).doNothing())
    .returning([...MEMBERSHIP_COLUMNS])
    .executeTakeFirst()
  const membership = inserted ?? (await liveMembership())!

  const { deleted_at: _d, expired: _e, ...beforeRow } = inv
  const before = invitationRecord.parse(dated(beforeRow))
  const accepted = await ctx.trx
    .updateTable('invitations')
    .set({ accepted_at: sql`now()`, accepted_by: user.id })
    .where('id', '=', inv.id)
    .returning([...INVITATION_COLUMNS])
    .executeTakeFirstOrThrow()
  const after: InvitationRecord = invitationRecord.parse(dated(accepted))
  const record = membershipRecord.parse(dated(membership))

  await ctx.emitFor(inv.organization_id, {
    type: 'invitation.accepted',
    resourceType: 'invitation',
    resourceId: inv.id,
    before,
    after,
  })
  if (inserted) {
    await ctx.emitFor(inv.organization_id, {
      type: 'membership.created',
      resourceType: 'membership',
      resourceId: record.id,
      before: null,
      after: record,
    })
  }
  return record
}
