// The apply side of the hq auth migration ([[OPS392]], [[OPS250]] D1, D3, D4, D13): the control batch, then the CRM batch (the commit point), over two D1 handles.
// STUB for the red commit: the real module replaces it.
import type { D1Like } from '@vibase/storage-d1'
import type { AuthPlan, Snapshot } from './types.js'

export class ApplyRefusal extends Error {}
export class ApplyFailure extends Error {}
export const EXIT_REFUSED = 1
export const EXIT_FAILED_AFTER_WRITE = 2
export type ApplyState = 'not_applied' | 'applied'

export interface ApplyOptions {
  plan: AuthPlan
  fresh: Snapshot
  crm: D1Like
  control: D1Like
  now(): Date
  newId(): string
}
export interface ApplyOutcome {
  state: ApplyState
  control_inserted: number
  users_repointed: number
  agents_relinked: number
  agents_disabled: number
  memberships_inserted: number
}

export function assessState(_plan: AuthPlan, _fresh: Snapshot): ApplyState {
  throw new Error('not implemented')
}
export function describePlan(_plan: AuthPlan): string[] {
  throw new Error('not implemented')
}
export function exitCodeFor(_e: unknown): number {
  throw new Error('not implemented')
}
export async function applyBatches(_o: ApplyOptions): Promise<ApplyOutcome> {
  throw new Error('not implemented')
}
export async function applyControlBatch(_control: D1Like, _plan: AuthPlan, _now: Date): Promise<{ inserted: number }> {
  throw new Error('not implemented')
}
