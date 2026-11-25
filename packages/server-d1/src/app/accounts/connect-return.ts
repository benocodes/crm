// [[UI467]] D4, P2 ([[UI458]]): the connect return. The Gmail callback sends the browser back with `connection_id` or `error`; the page reads both, removes them from the URL and says what happened.
// The table is app code, equal to `@vibase/api`'s `CONNECT_ERROR_TEXT` (a node test compares codes and sentences): the browser bundle never imports `@vibase/api`.
export const CONNECT_ERROR_TEXT: Record<string, string> = {
  state_invalid: 'This connect link is invalid or has expired. Start again.',
  consent_denied: 'The connection was cancelled at Google. Nothing was connected.',
  scope_missing: 'Gmail access was not granted. Start again and leave the Gmail permission ticked.',
  not_a_member: 'Your account is not allowed to connect a mailbox to this workspace.',
  session_mismatch:
    'Sign in to this workspace in this browser as the person who started the connection, then start again.',
  exchange_failed: 'Google did not complete the connection. Start again.',
  temporarily_unavailable: 'The connection could not be completed right now. Try again in a minute.',
}
const UNKNOWN_ERROR = 'The mailbox was not connected.'

export type ConnectReturn = { kind: 'connected'; connectionId: string } | { kind: 'error'; code: string }

/** Reads `error` (it wins) or `connection_id` from a query string and returns it with the query minus both, other parameters kept in order (`''` when none are left, else `?…`). */
export function takeConnectReturn(search: string): { ret: ConnectReturn | null; search: string } {
  const params = new URLSearchParams(search)
  const error = params.get('error')
  const connectionId = params.get('connection_id')
  if (error === null && connectionId === null) return { ret: null, search }
  params.delete('error')
  params.delete('connection_id')
  const rest = params.toString()
  const ret: ConnectReturn | null = error
    ? { kind: 'error', code: error }
    : connectionId
      ? { kind: 'connected', connectionId }
      : null
  return { ret, search: rest ? `?${rest}` : '' }
}

/** What the Alert says. `address` is the connection's address from the loaded list; `null` when the id is not listed (or its address could not be read). */
export function describeReturn(
  ret: ConnectReturn,
  address: string | null,
): { variant: 'success' | 'error'; text: string } {
  if (ret.kind === 'connected')
    return { variant: 'success', text: address ? `Connected ${address}.` : 'Mailbox connected.' }
  return {
    variant: 'error',
    text: `${(Object.hasOwn(CONNECT_ERROR_TEXT, ret.code) ? CONNECT_ERROR_TEXT[ret.code] : undefined) ?? UNKNOWN_ERROR} (${ret.code})`,
  }
}
