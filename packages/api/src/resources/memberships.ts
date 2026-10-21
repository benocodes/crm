import { z } from 'zod'
import { membershipRecord, type MembershipRecord } from '../account/organizations.js'
import { defineResource } from './define.js'

/**
 * Read-only ([[CORE3]] D1, D14): Clerk is the source of truth, so the vault writes memberships only through
 * the directory sync. No last-owner guard is needed here.
 */
export const memberships = defineResource<MembershipRecord>({
  name: 'memberships',
  eventName: 'membership',
  table: 'memberships',
  scopeResource: 'members',
  operations: ['list', 'get'],
  record: membershipRecord,
  filters: { user_id: { schema: z.uuid() }, role: { schema: z.enum(['owner', 'member']) } },
})
