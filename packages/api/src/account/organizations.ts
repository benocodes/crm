import { z } from 'zod'

/** The record shapes of organisations and memberships, as they appear in events and responses. */
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
