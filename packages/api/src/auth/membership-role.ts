import { defineOperation, execute, readMaybe, unit, type PreparedOperation, type QueryContext, type Read, type StorageBinding } from '@vibase/storage'
import { mapStorageError } from '../errors.js'
import type { Role } from './roles.js'

const KEY = 'membership:role'

/** The roles a workspace admits: `owner` and `member`; a stored `agent` or anything else is none. */
export const admittedRole = (value: unknown): Role | null => (value === 'owner' || value === 'member' ? value : null)

/** The live-membership read, shared by the principal lookup (every request) and the role re-check: users linked to (provider, subject), their non-deleted membership in `organizationId`. */
export function membershipRoleRead(qc: QueryContext, a: { provider: string; subject: string; organizationId: string }): Read {
  return readMaybe(
    qc.db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('memberships.role')
      .where('users.auth_provider', '=', a.provider)
      .where('users.auth_subject', '=', a.subject)
      .where('memberships.organization_id', '=', a.organizationId)
      .where('memberships.deleted_at', 'is', null),
  )
}

/**
 * The live workspace role of a signed-in subject on the built-in provider ([[CORE244]] D7): the `users` row linked to (provider, subject) and its non-deleted `memberships` row in the
 * deployment's organisation. Read-only, one unit, no cache: removal and a role change apply to the very next request. `null` when the subject has no user, no live membership, or a stored
 * role the workspace does not admit (anything but `owner` and `member`).
 */
export function membershipRoleOperation(a: { provider: string; subject: string; organizationId: string }): PreparedOperation<Role | null> {
  return defineOperation<Role | null>({
    name: 'auth.membership_role',
    mutates: false,
    reads: (qc) => ({ [KEY]: membershipRoleRead(qc, a) }),
    build: (found) => unit({ steps: [], events: [], decode: () => admittedRole(found.maybe(KEY)?.role) }),
  })
}

/** `roleOf` for the Gmail callback's and the sync claim's role re-check ([[CHN5]] D33) on the built-in provider: the live membership, read on every call ([[CORE244]] D7). */
export function membershipRoleReader(storage: StorageBinding, provider: string): (subject: string) => Promise<Role | null> {
  if (storage.kind !== 'd1') throw new Error('the built-in provider serves a D1 deployment only')
  return async (subject) => {
    try {
      return (await execute(storage, { kind: 'internal', organizationId: null }, membershipRoleOperation({ provider, subject, organizationId: storage.organizationId }))).value
    } catch (err) {
      throw mapStorageError(err)
    }
  }
}
