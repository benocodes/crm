// [[OPS307]] D9, D10, D11: the owner recovery both front-ends share (`vibase-server owner-reset` and `bootstrap --remote --owner-reset`). STUB: the red commit's smallest module.
import type { D1Like } from '@vibase/storage-d1'

/** Refused before any write. */
export class OwnerResetRefusal extends Error {}
/** Failed after a write began. */
export class OwnerResetFailure extends Error {}

export interface OwnerResetRecord {
  authProvider: string
  hasControl: boolean
  publicBaseUrl: string | undefined
}
export interface OwnerResetDatabases {
  crm: D1Like
  control: D1Like | undefined
}
export interface OwnerResetParams {
  record: OwnerResetRecord
  authSecret: string | undefined
  secretsFile: string
  email: string | undefined
  dryRun: boolean
  withDatabases<T>(fn: (dbs: OwnerResetDatabases) => Promise<T>): Promise<T>
  now?: () => Date
  newId?: () => string
  randomBytes?: (n: number) => Uint8Array
}
export type OwnerResetResult =
  | { kind: 'dry-run'; action: 'reset' | 'invitation'; email: string }
  | { kind: 'reset'; email: string; url: string; expiresAt: string }
  | { kind: 'invitation'; email: string; url: string; expiresAt: string; revoked: number }

export async function ownerReset(_p: OwnerResetParams): Promise<OwnerResetResult> {
  throw new OwnerResetRefusal('owner-reset is not implemented')
}
export function ownerResetLines(_r: OwnerResetResult): string[] {
  return []
}
