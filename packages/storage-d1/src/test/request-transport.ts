// STUB for the red commit (OPS340): the request transport is not built yet.
import type { D1Like } from '../binding.js'

export type TransportKind = 'binding' | 'request'
export const MAX_SOCKETS = 16
export interface TransportStats {
  readonly maxSockets: number
  readonly opened: number
  readonly open: number
  readonly peakOpen: number
  readonly peakInFlight: number
  readonly requests: number
  readonly closed: boolean
}
export function harnessScript(): string {
  throw new Error('not implemented')
}
export function createRequestTransport(
  _url: URL,
  _names: readonly string[],
  _opts?: { maxSockets?: number },
): { bindings: Record<string, D1Like>; stats(): TransportStats; close(): Promise<void> } {
  throw new Error('not implemented')
}
export function transportStats(_local: object): TransportStats | undefined {
  return undefined
}
export function transportKindOf(_local: object): TransportKind {
  return 'binding'
}
