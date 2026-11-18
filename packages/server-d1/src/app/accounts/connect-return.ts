// [[UI467]] D4, P2 ([[UI458]]): the connect return.
export const CONNECT_ERROR_TEXT: Record<string, string> = {}
export type ConnectReturn = { kind: 'connected'; connectionId: string } | { kind: 'error'; code: string }
export function takeConnectReturn(_search: string): { ret: ConnectReturn | null; search: string } {
  throw new Error('not implemented')
}
export function describeReturn(
  _ret: ConnectReturn,
  _address: string | null,
): { variant: 'success' | 'error'; text: string } {
  throw new Error('not implemented')
}
