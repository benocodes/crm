import { sql } from 'kysely'
import { readMaybe, StorageError, type QueryContext, type Read, type Row } from '@vibase/storage'

/**
 * The effective capture settings of one connection ([[CHN406]] D11): the plain data [[CHN407]] (capture filters) and [[CORE408]] (contact
 * policy) read, so neither redefines the blocklist union. The two blocked lists are the live workspace entries and the connection's own,
 * deduplicated and sorted; a connection with no label row captures `INBOX` and `SENT` (a slip that left none must not stop capture silently).
 */
export interface CaptureSettings {
  connection_id: string
  capture_labels: string[]
  blocked_addresses: string[]
  blocked_domains: string[]
  exclude_group_addresses: boolean
  exclude_personal_domains: boolean
  contact_creation: 'sent_and_received' | 'sent' | 'none'
}

/** [[CHN5]] D5's pair, what no label row means ([[CHN406]] D11, D12). */
export const DEFAULT_CAPTURE_LABELS: readonly string[] = ['INBOX', 'SENT']

/**
 * A plan-phase read composable into a prepared program's `reads` (`reads: (qc) => ({ settings: s.read })`), then `s.decode(found.maybe(key))` in
 * `build` or `decode`. ONE query per call: the lists are aggregated in the row, so a capture page pays once, not per message or per list.
 * `decode` answers null for an unknown, soft-deleted or other-organisation connection. D1 only (the operations are `d1Only`).
 */
export function captureSettingsRead(
  qc: QueryContext,
  organizationId: string,
  connectionId: string,
): { read: Read; decode: (row: Row | null) => CaptureSettings | null } {
  if (qc.dialect !== 'd1') throw new StorageError('captureSettingsRead is D1 only')
  // The union is of two bound lookups (not correlated: a FROM subquery cannot see the outer row), so `union` deduplicates the value in both lists.
  const blocked = (kind: 'address' | 'domain') =>
    sql<string>`(select json_group_array(v order by v) from (
      select "blocked_senders"."value" as v from "blocked_senders"
        where "blocked_senders"."organization_id" = ${organizationId} and "blocked_senders"."kind" = ${kind} and "blocked_senders"."deleted_at" is null
      union
      select "connection_blocked_senders"."value" from "connection_blocked_senders"
        where "connection_blocked_senders"."organization_id" = ${organizationId} and "connection_blocked_senders"."connection_id" = ${connectionId} and "connection_blocked_senders"."kind" = ${kind}
    ))`
  const query = qc.db
    .selectFrom('channel_connections')
    .select([
      'channel_connections.id as connection_id',
      'channel_connections.exclude_group_addresses',
      'channel_connections.exclude_personal_domains',
      'channel_connections.contact_creation',
      sql<string>`(select json_group_array("connection_capture_labels"."label_id" order by "connection_capture_labels"."label_id") from "connection_capture_labels" where "connection_capture_labels"."connection_id" = "channel_connections"."id" and "connection_capture_labels"."organization_id" = "channel_connections"."organization_id")`.as(
        'capture_labels',
      ),
      blocked('address').as('blocked_addresses'),
      blocked('domain').as('blocked_domains'),
    ])
    .where('channel_connections.id', '=', connectionId)
    .where('channel_connections.organization_id', '=', organizationId)
    .where('channel_connections.deleted_at', 'is', null)
  return { read: readMaybe(query), decode: decodeCaptureSettings }
}

const list = (value: unknown): string[] => {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return Array.isArray(parsed) ? [...new Set(parsed as string[])].sort() : []
}
const flag = (value: unknown): boolean => value === true || value === 1 || value === '1'

export function decodeCaptureSettings(row: Row | null): CaptureSettings | null {
  if (!row) return null
  const labels = list(row.capture_labels)
  return {
    connection_id: String(row.connection_id),
    capture_labels: labels.length > 0 ? labels : [...DEFAULT_CAPTURE_LABELS],
    blocked_addresses: list(row.blocked_addresses),
    blocked_domains: list(row.blocked_domains),
    exclude_group_addresses: flag(row.exclude_group_addresses),
    exclude_personal_domains: flag(row.exclude_personal_domains),
    contact_creation: row.contact_creation as CaptureSettings['contact_creation'],
  }
}
