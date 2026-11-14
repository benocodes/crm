// STUB (red commit): the membership role read arrives with the implementation ([[CORE244]] D7).
import type { StorageBinding } from '@vibase/storage'
import type { Role } from './roles.js'

export function membershipRoleReader(_storage: StorageBinding, _provider: string): (subject: string) => Promise<Role | null> {
  return async () => null
}
