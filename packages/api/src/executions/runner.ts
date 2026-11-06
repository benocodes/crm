import type { StorageBinding } from '@vault/storage'
import type { Registry } from '../registry.js'
import type { TransportRegistry } from './transport.js'

/** The per-minute cron expression ([[AGT8]] D54): the expiry sweep, then the runner sweep. */
export const RAIL_CRON = '* * * * *'
export const MAX_ATTEMPTS = 5
export const EXECUTION_LEASE_MS = 60_000
export const DEADLINE_MS = 10 * 60_000
export const EXPIRY_BATCH = 100
export const DUE_BATCH = 5

export interface RailDeps {
  binding: StorageBinding
  registry: Registry
  transports: TransportRegistry
  clock: () => Date
  newId: () => string
}
export type RunOutcome = { outcome: 'done' | 'failed' | 'retry' | 'skipped'; code?: string }

const notYet = (): never => {
  throw new Error('the execution runner is not implemented yet')
}
/** Stub: one attempt at one execution. */
export const runExecution = (_d: RailDeps, _id: string): Promise<RunOutcome> => Promise.resolve(notYet())
/** Stub: the runner sweep of the per-minute tick. */
export const runDueExecutions = (_d: RailDeps): Promise<{ attempted: number }> => Promise.resolve(notYet())
/** Stub: the expiry sweep of the per-minute tick. */
export const expireOverdueRequests = (_d: RailDeps): Promise<{ expired: number }> => Promise.resolve(notYet())
/** Stub: the per-minute tick. */
export const railTick = (_d: RailDeps): Promise<{ expired: number; attempted: number }> => Promise.resolve(notYet())
