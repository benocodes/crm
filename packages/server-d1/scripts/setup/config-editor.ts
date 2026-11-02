export interface DesiredEnv {
  env: string
  workerName: string
  d1Name: string
  d1Id: string
  r2Name: string
  apiHost: string
  corsOrigins: string
}
export interface ReconcileResult {
  text: string
  /** Dotted paths the edit added or filled. */
  changed: string[]
  /** Dotted paths whose present value differs from the desired one. */
  mismatches: string[]
}

/** Adds what `env.<name>` lacks to a JSONC document, never overwriting ([[OPS65]] D9). Stub: red tests first. */
export function reconcileEnvBlock(_text: string, _desired: DesiredEnv): ReconcileResult {
  throw new Error('not implemented')
}
