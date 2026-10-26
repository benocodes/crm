import type { PreparedOperation, StorageBinding } from '@vault/storage'
import type { InternalEnv } from '../storage/internal.js'
import type { AuthAdapter } from './adapter.js'
import type { Role } from './roles.js'

const nope = (): never => {
  throw new Error('not implemented')
}

/**
 * A known user and, when the token names an organisation the vault already has, what its copy says: the
 * linked organisation's id and the user's most recently updated membership row there (live or soft-deleted;
 * [[CORE3]] D20). Both are null for first sight, which the caller re-resolves through repair.
 */
export type UserLogin = {
  userId: string
  linkedOrganizationId: string | null
  latestMembership: { role: Role; deletedAt: Date | null; updatedAt: Date } | null
}
type Lookup = { provider: string; subject: string; organizationExternalId: string | null }
type FirstSight = { provider: string; subject: string; email: string; name: string | null; emailVerified: boolean; principalId: string; now: Date }

export function lookupUserOperation(_a: Lookup): PreparedOperation<UserLogin | null> {
  return nope()
}
export function firstSightOperation(_a: FirstSight): PreparedOperation<UserLogin> {
  return nope()
}
export function firstSightRecheckOperation(_a: { provider: string; subject: string; email: string }): PreparedOperation<UserLogin> {
  return nope()
}
export async function lookupUser(_storage: StorageBinding, _a: Lookup): Promise<UserLogin | null> {
  return nope()
}
export async function provisionUser(_storage: StorageBinding, _adapter: AuthAdapter, _subject: string, _env: InternalEnv): Promise<UserLogin> {
  return nope()
}
