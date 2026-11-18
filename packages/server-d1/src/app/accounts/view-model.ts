// [[UI467]] D2, D3, D10, D12, P1, P3 ([[UI458]]): the Connected accounts page's logic as a pure view model: rows split and ordered, each row's title, meta, status and actions, and the page's access. No DOM, no network; the view takes `now` for the relative time.
import type { ConnectionRecord } from '../session/types.js'

export interface AccountRowModel {
  id: string
  title: string
  meta: string[]
  status: { text: string; tone: 'neutral' | 'warning' }
  /** P1: Reconnect is the only row action until [[UI468]] (Settings, Sync now, Disconnect). */
  actions: 'reconnect'[]
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
    title: address || NO_ADDRESS,
    meta,
    status: (Object.hasOwn(STATUS, c.status) ? STATUS[c.status] : undefined) ?? { text: c.status, tone: 'neutral' },
    // D3: Reconnect only on the person's own rows that are not active; on another member's row it would move ownership to whoever consents.
    actions: own && canWrite && c.status !== 'active' ? ['reconnect'] : [],
  }
}

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
