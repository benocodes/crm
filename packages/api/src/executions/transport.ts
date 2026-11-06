// [[AGT8]] D52: the transport port of the execution rail. The runner resolves a transport per enqueued operation (by the name the operation
// declares); `dispatch` makes the one external effect, `reconcile` (optional) asks whether an earlier, uncertain dispatch took effect.
// Provider mechanics stay behind this port; the classification is what the retry policy needs and no more.

/** The permanent failure classes of [[AGT8]] D14 a transport may report for a definite `not_sent`. */
export const PERMANENT_CODES = ['reauth_required', 'permission_missing', 'anchor_missing', 'provider_rejected'] as const
export type PermanentCode = (typeof PERMANENT_CODES)[number]
/** Every code an execution can fail with ([[AGT8]] D14). */
export type FailureCode = PermanentCode | 'outcome_unknown' | 'attempts_exhausted' | 'deadline_passed'

export type DispatchOutcome =
  | { kind: 'sent'; result: Record<string, unknown> }
  /** Definitely not delivered. `retryable` is retried with backoff (a throttle sets `retryAfterMs`); a permanent code fails the execution. */
  | { kind: 'not_sent'; code: 'retryable'; retryAfterMs?: number; message?: string }
  | { kind: 'not_sent'; code: PermanentCode; message?: string }
  /** May have been delivered: the response was lost. */
  | { kind: 'unknown'; message?: string }
export type ReconcileOutcome = { kind: 'found'; result: Record<string, unknown> } | { kind: 'not_found' } | { kind: 'unknown' }

/** What a transport is given: fixed at authorisation, so `clientRef` is identical on every attempt. */
export interface TransportCall {
  executionId: string
  operation: string
  /** The operation's final arguments (the flat shape of an action request). */
  arguments: Record<string, unknown>
  /** What was resolved at authorisation ([[AGT8]] D9): an anchor, a connection. */
  resolution: Record<string, unknown>
  clientRef: string
  /** 1-based, counted at claim. */
  attempt: number
}
export interface Transport {
  dispatch(call: TransportCall): Promise<DispatchOutcome>
  reconcile?(call: TransportCall): Promise<ReconcileOutcome>
}
export type TransportRegistry = Readonly<Record<string, Transport>>
