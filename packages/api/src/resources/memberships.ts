import { z } from 'zod'
import { membershipRecord, type MembershipRecord } from '../account/organizations.js'
import { definePreparedResource, type PreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { deleteMembershipOperation, membershipUpdateBody, updateMembershipOperation } from '../members/operations.js'
import { withColumnFilters } from '../storage/column-filters.js'

/**
 * Reads are generic. On Clerk the vault writes memberships only through the directory sync ([[CORE3]] D1, D14, [[CORE41]]); on the built-in provider an owner changes a role or removes a member
 * through `memberships.update` and `memberships.delete` ([[CORE288]]), registered here with their operations in `members/operations.ts` (the last-owner guard, the control store) and answering
 * `501 provider_not_configured` where composition has none. Not proposable: human-only administration.
 */
export const memberships: PreparedResource<'memberships', MembershipRecord> = withColumnFilters(withColumnSorts(definePreparedResource({
  surface: 'meta',
  name: 'memberships',
  eventName: 'membership',
  table: 'memberships',
  scopeResource: 'members',
  operations: ['list', 'get', 'update', 'delete'],
  notProposable: 'membership administration is human-only and not proposable',
  record: membershipRecord,
  update: membershipUpdateBody,
  override: {
    update: (env, input) => updateMembershipOperation(memberships, env, (input as { id: string }).id, (input as { body: unknown }).body),
    delete: (env, id) => deleteMembershipOperation(memberships, env, id as string),
  },
  filters: { user_id: { schema: z.uuid() }, role: { schema: z.enum(['owner', 'member']) } },
}), []))
