import { sql } from 'kysely'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { invitationKey, lockKeys } from '../identity/locks.js'
import { deleteResource } from './crud.js'
import { defineResource } from './define.js'

export const invitationRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  email: z.string(),
  role: z.enum(['owner', 'member']),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  accepted_by: z.uuid().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type InvitationRecord = z.infer<typeof invitationRecord>

/** An invitation stays open for this long ([[CORE3]] D10). */
const LIFETIME = sql`now() + interval '336 hours'`

export const invitations = defineResource<InvitationRecord>({
  name: 'invitations',
  eventName: 'invitation',
  table: 'invitations',
  scopeResource: 'members',
  operations: ['list', 'get', 'create', 'delete'],
  record: invitationRecord,
  create: z.strictObject({ email: z.email().max(320), role: z.enum(['owner', 'member']) }),
  async beforeWrite(ctx, { input }) {
    const email = String(input.email).trim().toLowerCase()
    await lockKeys(ctx.trx, [invitationKey(ctx.organizationId, email)])
    const open = await ctx.trx
      .selectFrom('invitations')
      .select(['id', sql<boolean>`expires_at > now()`.as('pending')])
      .where('organization_id', '=', ctx.organizationId)
      .where('email', '=', email)
      .where('deleted_at', 'is', null)
      .where('accepted_at', 'is', null)
      .execute()
    if (open.some((i) => i.pending)) {
      throw new ApiError(409, 'invitation_exists', `a pending invitation for ${email} already exists`)
    }
    // The partial unique index cannot see expiry: retire expired ones so the new row fits.
    for (const stale of open) await deleteResource(ctx, invitations, stale.id)
    return { ...input, email, expires_at: LIFETIME }
  },
})
