import { z } from 'zod'
import { membershipRecord, type MembershipRecord } from '../account/organizations.js'
import type { ServiceContext } from '../context.js'
import { ApiError } from '../errors.js'
import { defineResource } from './define.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The last-owner guard ([[CORE3]] D14). Locks the organisation's owner rows in id order BEFORE the generic
 * layer locks the target, so two owners demoting each other wait on one another's lock instead of
 * deadlocking; the second re-reads the owners and is refused.
 */
async function guardLastOwner(ctx: ServiceContext, id: string, removesOwnership: boolean): Promise<void> {
  const target = id.toLowerCase()
  if (!UUID.test(target)) return // the generic layer answers 404
  const owners = await ctx.trx
    .selectFrom('memberships')
    .select('id')
    .where('organization_id', '=', ctx.organizationId)
    .where('role', '=', 'owner')
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .forUpdate()
    .execute()
  if (removesOwnership && owners.length === 1 && owners[0]!.id === target) {
    throw new ApiError(409, 'last_owner', 'an organisation must keep at least one owner')
  }
}

export const memberships = defineResource<MembershipRecord>({
  name: 'memberships',
  eventName: 'membership',
  table: 'memberships',
  scopeResource: 'members',
  operations: ['list', 'get', 'update', 'delete'],
  record: membershipRecord,
  update: z.strictObject({ role: z.enum(['owner', 'member']) }).partial(),
  filters: { user_id: { schema: z.uuid() }, role: { schema: z.enum(['owner', 'member']) } },
  overrides: {
    async update(ctx, id, input, generic) {
      await guardLastOwner(ctx, id, input.role === 'member')
      return generic(id, input)
    },
    async delete(ctx, id, generic) {
      await guardLastOwner(ctx, id, true)
      await generic(id)
    },
  },
})
