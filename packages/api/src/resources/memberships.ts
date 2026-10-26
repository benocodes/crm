import { z } from 'zod'
import { membershipRecord } from '../account/organizations.js'
import { definePreparedResource } from '../storage/definition.js'

/**
 * Read-only ([[CORE3]] D1, D14): Clerk is the source of truth, so the vault writes memberships only through
 * the directory sync (legacy until [[CORE41]]). No last-owner guard is needed here.
 */
export const memberships = definePreparedResource({
  name: 'memberships',
  eventName: 'membership',
  table: 'memberships',
  scopeResource: 'members',
  operations: ['list', 'get'],
  record: membershipRecord,
  filters: { user_id: { schema: z.uuid() }, role: { schema: z.enum(['owner', 'member']) } },
})
