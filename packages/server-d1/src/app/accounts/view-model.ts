// [[UI467]] D2, D3, D10, D12, P1, P3 ([[UI458]]): the Connected accounts page's logic as a pure view model.
export interface AccountRowModel {
  id: string
  title: string
  meta: string[]
  status: { text: string; tone: 'neutral' | 'warning' }
  actions: 'reconnect'[]
}
export interface AccountsView {
  access: boolean
  canConnect: boolean
  yours: AccountRowModel[]
  others: AccountRowModel[]
}
export interface ConnectionLike {
  id: string
  owner_id: string
  identity_id: string
  status: string
  last_synced_at?: string | null
  last_error_code?: string | null
}
export function relativeTime(_iso: string, _now: Date): string {
  throw new Error('not implemented')
}
export function buildAccountsView(_input: {
  scopes: readonly string[]
  userId: string
  connections: readonly ConnectionLike[]
  addresses: Readonly<Record<string, string | null>>
  now: Date
}): AccountsView {
  throw new Error('not implemented')
}
