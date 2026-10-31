import { sql } from 'kysely'
import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'

const lower = (v: unknown) => (v as string).toLowerCase()

/**
 * Read-only ([[CORE25]] D26), `interactions:read`: who did what with whom and when. Participants are identities embedded
 * ordered by role then identity id. `identity_id` and `contact_id` are join filters (D51): `contact_id` follows the
 * identities that are live NOW, so after a merge the survivor owns the interactions and a deleted identity drops out.
 */
export const interactions = definePreparedResource({
  name: 'interactions',
  eventName: 'interaction',
  table: 'interactions',
  associable: true,
  scopeResource: 'interactions',
  operations: ['list', 'get'],
  record: z.object({
    id: z.uuid(),
    kind: z.enum(['message', 'reaction']),
    channel: z.enum(['email']),
    direction: z.enum(['inbound', 'outbound']),
    occurred_at: z.string(),
    thread_id: z.uuid().nullable(),
    message_id: z.uuid().nullable(),
    participants: z.array(z.object({ identity_id: z.uuid(), role: z.enum(['from', 'to', 'cc', 'bcc']) })),
    created_by: z.uuid(),
    created_at: z.string(),
  }),
  embed: {
    participants: { table: 'interaction_participants', key: 'interaction_id', columns: ['identity_id', 'role'], orderBy: ['role', 'identity_id'] },
  },
  filters: {
    kind: { schema: z.enum(['message', 'reaction']) },
    channel: { schema: z.enum(['email']) },
    direction: { schema: z.enum(['inbound', 'outbound']) },
    thread_id: { schema: z.uuid(), normalize: lower },
    message_id: { schema: z.uuid(), normalize: lower },
  },
  joinFilters: {
    identity_id: {
      schema: z.uuid(),
      normalize: lower,
      where: (_qc, value) =>
        sql<boolean>`exists (select 1 from "interaction_participants" as "p" where "p"."interaction_id" = "interactions"."id" and "p"."organization_id" = "interactions"."organization_id" and "p"."identity_id" = ${value as string})`,
    },
    contact_id: {
      schema: z.uuid(),
      normalize: lower,
      where: (_qc, value) =>
        sql<boolean>`exists (select 1 from "interaction_participants" as "p" join "identities" as "i" on "i"."id" = "p"."identity_id" and "i"."organization_id" = "p"."organization_id" where "p"."interaction_id" = "interactions"."id" and "p"."organization_id" = "interactions"."organization_id" and "i"."contact_id" = ${value as string} and "i"."deleted_at" is null)`,
    },
  },
})
