// [[UI461]] D10, P4: STUB (red commit).
export type ConnectAgentCheck = { status: 'show' } | { status: 'hidden' } | { status: 'error'; message: string }
export interface GetStarted {
  prompt: boolean
  error: string | null
}
export const getStarted = (_c: ConnectAgentCheck): GetStarted | null => ({ prompt: true, error: null })
