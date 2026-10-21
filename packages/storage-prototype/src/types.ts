import type { Actor, ScopeSet } from '@vault/api'
export type ExecutionContext = { organizationId: string; actor: Actor; scopes: ScopeSet }
export type Preparation = { operationId: string; now: string; nextId: () => string }
export type LockIntent = { table: 'tasks'; id: string } | { key: string }
export type PreparedOperation<T> = {
  readonly kind: 'task' | 'resolve'
  readonly requiredScope: 'tasks:write' | 'contacts:write'
  readonly context: ExecutionContext
  readonly operationId: string
  readonly now: string
  readonly input: any
  readonly eventId: string
  readonly rowId: string
  readonly locks: readonly LockIntent[]
  readonly result?: T
}
export type Statement = { label: string; sql: string; parameters: unknown[] }
export type CompiledProgram<T> = {
  context: ExecutionContext
  dialect: 'postgres' | 'd1'
  statements: Statement[]
  resultIndex: number
  locks: readonly LockIntent[]
  decode: (rows: Record<string, any>[]) => { value: T; eventOrder: { id: string; ordinal: number }[] }
}
export type ExecutionMetrics = {
  statements: number
  physicalRequests: number
  setupRoundTrips: number
  lockRoundTrips: number
  resultRows: number
  rowsRead: number | null
  rowsWritten: number | null
  elapsedMs: number
}
export type Execution<T> = {
  value: T
  eventOrder: readonly { id: string; ordinal: number }[]
  metrics: ExecutionMetrics
}
export interface StorageRuntime {
  execute<T>(program: CompiledProgram<T>): Promise<Execution<T>>
}
