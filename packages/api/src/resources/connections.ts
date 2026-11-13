import { sql, type Expression } from 'kysely'
import { z } from 'zod'
import type { QueryContext } from '@vibase/storage'
import { definePreparedResource, type DerivedDecl } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

export type ConnectionRecord = {
  id: string
  organization_id: string
  provider: 'google'
  account_id: string
  identity_id: string
  owner_id: string
  status: 'active' | 'reauth_required' | 'suspended'
  granted_scopes: string[]
  connected_at: string
  created_by: string
  created_at: string
  updated_at: string
  last_synced_at?: string | null
  last_error_code?: string | null
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  provider: z.enum(['google']).describe('The provider of the account; google only for now.'),
  account_id: z.string().describe("The provider's stable id for the account (Google's `sub`). Not the address: an address can change."),
  identity_id: z.uuid().describe("The own identity that is the connected mailbox's address."),
  owner_id: z.uuid().describe('The user who owns the connection now; the person whose approval sends from it. A reconnect by another person moves it.'),
  status: z.enum(['active', 'reauth_required', 'suspended']).describe('active works; reauth_required when the provider refused the stored grant; suspended when the owner is no longer admitted. A reconnect makes it active again.'),
  granted_scopes: z.array(z.string()).describe('The OAuth scopes the person granted at the provider.'),
  connected_at: z.string().describe('When the connection was made or last reconnected.'),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  last_synced_at: z.string().nullable().optional().describe('When the mailbox was last brought up to date; null until a sync has finished. Derived, read-only.'),
  last_error_code: z.string().nullable().optional().describe('A short code for the last sync failure; null when the last run was fine or none ran. Derived, read-only.'),
})

/** The correlated scalar of a derived field: one indexed lookup by the connection id (the machinery tables key on it). */
const fromMachinery = (table: 'mail_sync_cursors' | 'mail_sync_state', column: string) => (_qc: QueryContext, parent: (column: string) => Expression<unknown>): Expression<unknown> =>
  sql`(select ${sql.ref(`${table}.${column}`)} from ${sql.table(table)} where ${sql.ref(`${table}.connection_id`)} = ${parent('id')} and ${sql.ref(`${table}.organization_id`)} = ${parent('organization_id')})`

const derived = {
  last_synced_at: { kind: 'timestamp', expression: fromMachinery('mail_sync_cursors', 'last_synced_at') },
  last_error_code: { kind: 'text', expression: fromMachinery('mail_sync_state', 'last_error_code') },
} as const satisfies Record<string, DerivedDecl>

/**
 * Connections ([[CHN5]] D3, D20, D42): a grant to one Google account, read and disconnect only. There is no create or update route: a connection
 * comes into being in the OAuth callback's unit (`connect.ts`), the only writer besides the sync engine's status changes. Delete soft-deletes it
 * and removes its four machinery rows in the same unit (D26): a secret has no history worth keeping. Captured messages and sources stay (D27).
 * D1 only (D29): on another engine every operation answers `501 not_implemented`.
 */
export const connections = withColumnFilters(withColumnSorts(definePreparedResource({
  notProposable: 'connection management is not proposable',
  surface: 'meta',
  name: 'connections',
  eventName: 'connection',
  table: 'channel_connections',
  d1Only: true,
  operations: ['list', 'get', 'delete'],
  derived,
  record,
  after: ({ qc, env, op, id }) => {
    if (op !== 'delete') return []
    const org = env.organizationId
    return [
      { query: qc.db.deleteFrom('channel_credentials').where('connection_id', '=', id).where('organization_id', '=', org) },
      { query: qc.db.deleteFrom('gmail_watches').where('connection_id', '=', id).where('organization_id', '=', org) },
      { query: qc.db.deleteFrom('mail_sync_state').where('connection_id', '=', id).where('organization_id', '=', org) },
      { query: qc.db.deleteFrom('mail_sync_cursors').where('connection_id', '=', id).where('organization_id', '=', org) },
    ]
  },
}), ['last_synced_at']))
