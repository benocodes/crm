import type { QueryContext, Read, Row, Step } from '@vault/storage'

const nope = (): never => {
  throw new Error('not implemented')
}
export const SYSTEM_PRINCIPAL_READ = 'system:principal'
export function systemPrincipalRead(_qc: QueryContext): Read {
  return nope()
}
export function systemPrincipalSteps(_qc: QueryContext, _found: Row | null, _mint: string, _now: string): { id: string; steps: Step[] } {
  return nope()
}
