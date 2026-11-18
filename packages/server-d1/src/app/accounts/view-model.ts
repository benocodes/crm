// [[UI467]] D2, D3, D10, D12, P1, P3 ([[UI458]]): the Connected accounts page's logic as a pure view model: rows split and ordered, each row's title, meta, status and actions, and the page's access. No DOM, no network; the view takes `now` for the relative time.
import type { ConnectionRecord } from '../session/types.js'

export type AccountAction = 'settings' | 'sync' | 'reconnect' | 'disconnect'
export interface AccountRowModel {
  id: string
  /** The person's own mailbox (`owner_id` is theirs). */
  own: boolean
  title: string
  meta: string[]
  status: { text: string; tone: 'neutral' | 'warning' }
  /** [[UI468]] P4, in this order: Settings (read), Sync now (write, active rows), Reconnect (write, own non-active rows), Disconnect (write). */
  actions: AccountAction[]
}
export interface AccountsView {
  /** D12: `connections:read`. Without it the page shows no-access text and reads nothing. */
  access: boolean
  /** D12: `connections:write`, on a page that may be read. */
  canConnect: boolean
  yours: AccountRowModel[]
  others: AccountRowModel[]
}
export type ConnectionLike = Pick<
  ConnectionRecord,
  'id' | 'owner_id' | 'identity_id' | 'status' | 'last_synced_at' | 'last_error_code'
>

/** D10: the sentences for the codes the sync engine writes (`markConnectionStatus`: `invalid_grant`, `owner_not_admitted`). Any other code reads "Last sync failed.". */
const SYNC_ERROR_TEXT: Record<string, string> = {
  invalid_grant: 'Google no longer accepts this connection. Reconnect to resume syncing.',
  owner_not_admitted: 'The person who connected this mailbox is no longer a member of this workspace.',
}
const STATUS: Record<string, AccountRowModel['status']> = {
  active: { text: 'Connected', tone: 'neutral' },
  reauth_required: { text: 'Needs reconnect', tone: 'warning' },
  suspended: { text: 'Suspended', tone: 'warning' },
}
const NO_ADDRESS = 'Gmail account'

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`
/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then "on 2026-09-01" (a date from 30 days on; text that is not a date is shown as given). A clock ahead of the stamp reads "just now". */
export function relativeTime(iso: string, now: Date): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return `on ${iso}`
  const seconds = Math.floor((now.getTime() - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return plural(hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 30) return plural(days, 'day')
  return `on ${new Date(at).toISOString().slice(0, 10)}`
}

function row(
  c: ConnectionLike,
  address: string | null | undefined,
  own: boolean,
  canWrite: boolean,
  now: Date,
): AccountRowModel {
  const meta: string[] = []
  if (!own) meta.push("Another member's mailbox")
  meta.push(c.last_synced_at ? `Last synced ${relativeTime(c.last_synced_at, now)}` : 'Not synced yet')
  if (c.last_error_code)
    meta.push(
      `${(Object.hasOwn(SYNC_ERROR_TEXT, c.last_error_code) ? SYNC_ERROR_TEXT[c.last_error_code] : undefined) ?? 'Last sync failed.'} (${c.last_error_code})`,
    )
  return {
    id: c.id,
    own,
    title: address || NO_ADDRESS,
    meta,
    status: statusOf(c.status),
    actions: rowActions(c.status, own, canWrite),
  }
}

/** The status badge's text and tone for a connection status (an unknown status reads as itself). */
export function statusOf(status: string): AccountRowModel['status'] {
  return (Object.hasOwn(STATUS, status) ? STATUS[status] : undefined) ?? { text: status, tone: 'neutral' }
}

/** [[UI468]] P4. Settings for every `connections:read` holder (the caller of `row` has it); with write: Sync now on active rows (own and others', D9), Reconnect only on the person's own non-active rows (D3: on another member's row it would move ownership to whoever consents), Disconnect on every row (D8). */
function rowActions(status: string, own: boolean, canWrite: boolean): AccountAction[] {
  const actions: AccountAction[] = ['settings']
  if (!canWrite) return actions
  if (status === 'active') actions.push('sync')
  if (own && status !== 'active') actions.push('reconnect')
  actions.push('disconnect')
  return actions
}

export type RowNote = { kind: 'note'; variant: 'success' | 'error'; text: string } | { kind: 'reload' }
export const SYNC_REQUESTED = 'Sync requested. New mail appears shortly.'
export const SYNC_NOT_CONFIGURED =
  'This instance cannot sync mailboxes. Its operator sets up Gmail sync (see the setup guide).'
/** [[UI468]] D9, P5: what a `connections.sync` answer means for its row. `409` means the status changed: read the list again. */
export function syncOutcome(r: { status: number; code?: string; message?: string }): RowNote {
  if (r.status === 202) return { kind: 'note', variant: 'success', text: SYNC_REQUESTED }
  if (r.status === 409 || r.status === 404) return { kind: 'reload' }
  if (r.status === 501) return { kind: 'note', variant: 'error', text: SYNC_NOT_CONFIGURED }
  if (r.status === 503 && r.message) return { kind: 'note', variant: 'error', text: r.message }
  return { kind: 'note', variant: 'error', text: `Could not request a sync (${r.code ?? r.status}). Try again.` }
}

/** [[UI468]] D8, P6: a `404` on delete means it is already gone, which is what was asked for. */
export const disconnected = (r: { status: number }): boolean => r.status === 204 || r.status === 404

/** `addresses` is keyed by connection id (a failed or refused read is `null`, a read that never ran is absent). */
export function buildAccountsView(input: {
  scopes: readonly string[]
  userId: string
  connections: readonly ConnectionLike[]
  addresses: Readonly<Record<string, string | null>>
  now: Date
}): AccountsView {
  const access = input.scopes.includes('connections:read')
  const canWrite = access && input.scopes.includes('connections:write')
  if (!access) return { access, canConnect: false, yours: [], others: [] }
  const rows = input.connections.map((c) => ({
    own: c.owner_id === input.userId,
    model: row(c, input.addresses[c.id], c.owner_id === input.userId, canWrite, input.now),
  }))
  const sorted = (own: boolean) =>
    rows
      .filter((r) => r.own === own)
      .map((r) => r.model)
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  return { access, canConnect: canWrite, yours: sorted(true), others: sorted(false) }
}
