import type { Role } from './roles.js'

export type Resolution =
  | { organizationId: string; role: Role }
  | { organizationId: null; forbidden: boolean }

/**
 * The active organisation ([[CORE3]] D7): the token's organisation claim decides (`active`, null without a
 * claim). An X-Organization-Id header (any value, including empty) is only a cross-check: it must name that
 * same organisation, case-insensitively, or the request is forbidden.
 */
export function resolveActiveOrganization(
  active: { organizationId: string; role: Role } | null,
  header: string | undefined,
): Resolution {
  if (header === undefined) return active ?? { organizationId: null, forbidden: false }
  if (active && header.toLowerCase() === active.organizationId.toLowerCase()) return active
  return { organizationId: null, forbidden: true }
}
