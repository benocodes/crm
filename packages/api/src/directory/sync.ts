import type { PreparedOperation, StorageBinding } from '@vault/storage'
import type { AuthAdapter } from '../auth/adapter.js'
import type { Role } from '../auth/roles.js'
import type { InternalEnv } from '../storage/internal.js'

const nope = (): never => {
  throw new Error('not implemented')
}

export type ReconcileSummary = { organizationId: string | null; created: number; updated: number; deleted: number }
export type RefreshOutcome = 'updated' | 'unchanged' | 'unknown' | 'conflict' | 'unsupported'
export type RepairArgs = Record<string, never>
export type ReconcileArgs = Record<string, never>
export type RefreshArgs = Record<string, never>

export function repairOperation(_a: RepairArgs): PreparedOperation<string> {
  return nope()
}
export function reconcileOperation(_a: ReconcileArgs): PreparedOperation<ReconcileSummary> {
  return nope()
}
export function refreshUserOperation(_a: RefreshArgs): PreparedOperation<RefreshOutcome> {
  return nope()
}
export async function repairMembership(
  _storage: StorageBinding,
  _adapter: AuthAdapter,
  _a: { userId: string; externalId: string; role: Role; known: { organizationId: string | null } },
  _env: InternalEnv,
): Promise<string> {
  return nope()
}
export async function reconcileOrganization(_storage: StorageBinding, _adapter: AuthAdapter, _externalId: string, _env: InternalEnv): Promise<ReconcileSummary> {
  return nope()
}
export async function refreshUser(_storage: StorageBinding, _adapter: AuthAdapter, _subject: string, _env: InternalEnv): Promise<RefreshOutcome> {
  return nope()
}
