// The sync run ([[CHN5]] D11, D12, D16): Node-safe orchestrator. STUB (red commit).
import type { Role, ScopePolicy } from '../auth/roles.js'
import type { GmailSyncDeps } from '../channels/gmail/sync.js'
import type { MailSyncInstances, MailSyncParams } from './request.js'

export interface StepConfig {
  retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }
  timeout?: string | number
}
export interface WorkflowStepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>
  sleep(name: string, duration: string | number): Promise<void>
}
export interface WorkflowEventLike<P> {
  payload: P
}
/** What every step re-resolves from module factories; none of it is ever returned from a step. */
export interface MailSyncRuntime {
  pages: GmailSyncDeps
  /** Throws retryably while the database is `behind` ([[CHN5]] D37). */
  gate: () => Promise<void>
  roleOf: ((authSubject: string) => Promise<Role | null>) | null
  policy: ScopePolicy
  declaredScopes: readonly string[]
  instances: MailSyncInstances
}
export type MailSyncEnd = 'complete' | 'held' | 'inactive' | 'suspended' | 'reauth' | 'lease_lost'
export interface MailSyncSummary {
  end: MailSyncEnd
  passes: number
}
export async function runMailSync(_event: WorkflowEventLike<MailSyncParams>, _step: WorkflowStepLike, _resolve: () => Promise<MailSyncRuntime> | MailSyncRuntime): Promise<MailSyncSummary> {
  throw new Error('not implemented')
}
