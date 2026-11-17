import { z } from 'zod'
import { readMaybe } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { normalizeBlockedAddress, normalizeBlockedDomain } from '../connections/capture-input.js'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

export type BlockedSenderRecord = {
  id: string
  organization_id: string
  kind: 'address' | 'domain'
  value: string
  created_by: string
  created_at: string
  updated_at: string
}

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  kind: z
    .enum(['address', 'domain'])
    .describe('address: one sender (user@example.com); domain: every sender at a bare domain (example.com).'),
  value: z.string().describe('The address or domain, stored trimmed and lowercase.'),
  created_by: z.uuid().describe('The person who added the entry.'),
  created_at: z.string(),
  updated_at: z.string(),
})

// [[CHN410]] P4: the same two normalisers as a connection's own list (`connections.update`), so both accept and refuse the same values; `created_by` and `organization_id` are never input.
const create = z.strictObject({
  kind: z.enum(['address', 'domain']).describe('address: one sender; domain: a bare domain, without subdomains.'),
  value: z.string().describe('An address (user@example.com) or a bare domain (example.com); stored lowercase.'),
})

/**
 * The workspace blocklist ([[CHN406]] D8, [[CHN410]]): addresses and domains whose mail no connection of the workspace captures. Added and lifted by an owner, signed in
 * (`humanOnly`, P1; `blocked_senders:write` is owner-only and not agent-grantable); anyone holding `blocked_senders:read` reads it. There is no update: lift an entry and add another.
 * A live duplicate (same kind and normalised value) is refused in the plan (`409 blocked_sender_exists`, P2); the partial unique index is the commit-time backstop.
 * Delete is soft. Applying the list at capture is [[CHN407]]'s; the capture-settings read already unions the live entries with a connection's own.
 * D1 only: every operation answers `501 not_implemented` on another engine.
 */
export const blockedSenders = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      surface: 'meta',
      name: 'blocked_senders',
      eventName: 'blocked_sender',
      table: 'blocked_senders',
      d1Only: true,
      operations: ['list', 'get', 'create', 'delete'],
      notProposable: 'the workspace blocklist is an owner decision and is not proposable',
      humanOnly: 'changing the workspace blocklist needs a signed-in person',
      descriptions: {
        list: 'The workspace blocklist: addresses and domains whose mail no mailbox of the workspace captures. Filter by kind or by value (exact, lowercase). Example: vibase blocked-senders list --kind domain',
        get: 'One blocklist entry. Example: vibase blocked-senders get <id>',
        create:
          'Human only, and only an owner: block an address or a domain for every mailbox of the workspace. The value is stored lowercase; a domain is a bare hostname such as example.com (subdomains are not matched here). 409 blocked_sender_exists when the entry is already live; 403 user_required for an agent. Example: vibase blocked-senders create --kind domain --value spam.example',
        delete:
          'Human only, and only an owner: lift an entry (soft delete). 404 for an unknown or already lifted entry; 403 user_required for an agent. Example: vibase blocked-senders delete <id>',
      },
      record,
      create,
      // P3: the filter value is trimmed and lowercased, then matched exactly.
      filters: {
        kind: { schema: z.enum(['address', 'domain']) },
        value: { schema: z.string().min(1), normalize: (value) => String(value).trim().toLowerCase() },
      },
      prepare: ({ values }) => {
        const kind = values.kind as 'address' | 'domain'
        try {
          return {
            value:
              kind === 'address'
                ? normalizeBlockedAddress(values.value as string)
                : normalizeBlockedDomain(values.value as string),
          }
        } catch (err) {
          throw new ApiError(400, 'validation_error', `value: ${err instanceof Error ? err.message : 'invalid value'}`)
        }
      },
      conflicts: ({ qc, env, values }) => [
        {
          read: readMaybe(
            qc.db
              .selectFrom('blocked_senders')
              .select('blocked_senders.id')
              .where('blocked_senders.organization_id', '=', env.organizationId)
              .where('blocked_senders.kind', '=', values.kind as 'address' | 'domain')
              .where('blocked_senders.value', '=', values.value as string)
              .where('blocked_senders.deleted_at', 'is', null)
              .limit(1),
          ),
          refuse: (row) => {
            if (row)
              throw new ApiError(
                409,
                'blocked_sender_exists',
                `${String(values.kind)} ${String(values.value)} is already blocked (${String(row.id)})`,
              )
          },
        },
      ],
    }),
    ['kind', 'value'],
  ),
)
