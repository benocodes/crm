import type { UserLogin } from './first-sight.js'

export type Resolution =
  | { organizationId: string; role: 'owner' | 'member' }
  | { organizationId: null; forbidden: boolean }

/**
 * The active organisation ([[CORE3]] D7): an X-Organization-Id header (any value, including empty) must name a
 * live membership; without a header exactly one membership is the default.
 */
export function resolveOrganization(memberships: UserLogin['memberships'], header: string | undefined): Resolution {
  if (header !== undefined) {
    const wanted = header.toLowerCase()
    const found = memberships.find((m) => m.organizationId.toLowerCase() === wanted)
    return found ? { organizationId: found.organizationId.toLowerCase(), role: found.role } : { organizationId: null, forbidden: true }
  }
  if (memberships.length === 1) return { organizationId: memberships[0]!.organizationId, role: memberships[0]!.role }
  return { organizationId: null, forbidden: false }
}
