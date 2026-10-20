import { z } from 'zod'
import type { AccountContext } from '../context.js'
import { ApiError } from '../errors.js'

export const organizationRecord = z.object({ id: z.uuid(), name: z.string(), created_at: z.string(), updated_at: z.string() })
export const membershipRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  user_id: z.uuid(),
  role: z.enum(['owner', 'member']),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type OrganizationRecord = z.infer<typeof organizationRecord>
export type MembershipRecord = z.infer<typeof membershipRecord>

export const createOrganizationBody = z.strictObject({ name: z.string().trim().min(1).max(200) })

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d)

/**
 * Creates an organisation with the caller as its owner and emits `organization.created` then
 * `membership.created`, all in the account transaction ([[CORE3]] D11, C14). Cleans the name itself: a
 * service function gets no adapter parsing.
 */
export async function createOrganization(ctx: AccountContext, input: { name: string }): Promise<OrganizationRecord> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '' || name.length > 200) {
    throw new ApiError(400, 'validation_error', 'name must be 1 to 200 characters')
  }
  const org = await ctx.trx
    .insertInto('organizations')
    .values({ name })
    .returning(['id', 'name', 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow()
  const orgRecord = organizationRecord.parse({ ...org, created_at: iso(org.created_at), updated_at: iso(org.updated_at) })

  const membership = await ctx.trx
    .insertInto('memberships')
    .values({ organization_id: org.id, user_id: ctx.actor.id, role: 'owner', created_by: ctx.actor.id })
    .returning(['id', 'organization_id', 'user_id', 'role', 'created_by', 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow()
  const memberRecord = membershipRecord.parse({
    ...membership,
    created_at: iso(membership.created_at),
    updated_at: iso(membership.updated_at),
  })

  await ctx.emitFor(org.id, {
    type: 'organization.created',
    resourceType: 'organization',
    resourceId: org.id,
    before: null,
    after: orgRecord,
  })
  await ctx.emitFor(org.id, {
    type: 'membership.created',
    resourceType: 'membership',
    resourceId: membership.id,
    before: null,
    after: memberRecord,
  })
  return orgRecord
}
