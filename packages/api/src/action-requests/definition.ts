import { sql } from 'kysely'
import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'

export const ACTION_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'expired',
  'superseded',
  'executed',
  'failed',
] as const
export const evidenceItem = z.strictObject({ type: z.enum(['message', 'interaction']), id: z.uuid() })

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  operation: z.string().describe('The registered operation proposed, for example tasks.update.'),
  arguments: z
    .record(z.string(), z.unknown())
    .describe(
      "The operation's flat arguments as proposed (the MCP shape: path, query and body fields in one object). Never changed after creation.",
    ),
  edited_arguments: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('The complete replacement arguments a reviewer approved instead; null unless approved with an edit.'),
  status: z.enum(ACTION_REQUEST_STATUSES),
  reason: z.string(),
  evidence: z.array(evidenceItem),
  contact_id: z.uuid().nullable(),
  thread_id: z.uuid().nullable(),
  interaction_id: z.uuid().nullable(),
  dedup_key: z.string().nullable(),
  expires_at: z.string(),
  decided_by: z
    .uuid()
    .nullable()
    .describe('The principal (user or agent) that decided it; the system principal for an expiry.'),
  decided_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  superseded_by_id: z.uuid().nullable(),
  result: z
    .unknown()
    .describe(
      "What approval did: for an inline operation { events: [{ type, resource_type, resource_id }] }, the events it wrote; for a queued one the execution's result. Null until executed.",
    ),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  executed_at: z.string().nullable(),
  execution_id: z
    .uuid()
    .nullable()
    .optional()
    .describe('The execution a queued approval created; absent or null until then and for operations that run inline.'),
  target_summary: z
    .string()
    .nullable()
    .describe(
      "One line the vault wrote when the request was created, saying what it asks for as proposed (the operation, the target record's name, the changed fields; for a send the mailbox and recipients). Built from the request and the stored records, never from the proposer's reason; any outside text in it is quoted and shortened. Not rewritten by an edited approval; null on a request created before this field existed.",
    ),
  proposer_kind: z
    .enum(['user', 'agent', 'system'])
    .nullable()
    .optional()
    .describe('What kind of principal proposed it, as the vault knows it.'),
  proposer_name: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The proposer's name as registered now: a user's name (else email), an agent's name (an agent's name may be chosen by whoever registered it); null for the system principal.",
    ),
  proposer_acting_for: z
    .string()
    .nullable()
    .optional()
    .describe('For a delegated agent, the name (else email) of the member it acts for; null otherwise.'),
  sending_mailbox: z
    .string()
    .nullable()
    .optional()
    .describe(
      "For a messages.send request, the address of the connected mailbox its connection_id names, whatever the connection's status; null for every other operation and when the connection is gone.",
    ),
  created_by: z.uuid().describe('The principal that proposed it: the source.'),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ActionRequestRecord = z.infer<typeof record>

/**
 * The queue ([[AGT8]] D3): read through the generic list and get under `action_requests:read`; every write is a hand-written command
 * (`create`, `withdraw`, `approve`, `reject`, in `operations.ts`). The table has no `deleted_at` and no delete: a request is a record of a
 * decision. D1 only (D26): on another engine every operation answers `501 not_implemented`.
 */
export const actionRequests = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      notProposable:
        'action requests are decided through action_requests.approve and action_requests.reject, never proposed',
      surface: 'api',
      name: 'action_requests',
      eventName: 'action_request',
      table: 'action_requests',
      d1Only: true,
      operations: ['list', 'get'],
      record,
      // [[AGT8]] D48: `execution_id`, the request reads its execution through the execution's own link; `action_requests` stores no copy.
      // [[AGT588]] D9, D10: the proposer in words and the sending mailbox, read from the principals and the connection when the request is read.
      derived: {
        execution_id: {
          kind: 'text',
          expression: (_qc, parent) =>
            sql`(select "action_executions"."id" from "action_executions" where "action_executions"."action_request_id" = ${parent('id')})`,
        },
        proposer_kind: {
          kind: 'text',
          expression: (_qc, parent) =>
            sql`(select "principals"."kind" from "principals" where "principals"."id" = ${parent('created_by')})`,
        },
        proposer_name: {
          kind: 'text',
          expression: (_qc, parent) =>
            sql`(select case "principals"."kind" when 'user' then coalesce(nullif("users"."name", ''), "users"."email") when 'agent' then "agents"."name" end from "principals" left join "users" on "users"."id" = "principals"."id" left join "agents" on "agents"."id" = "principals"."id" where "principals"."id" = ${parent('created_by')})`,
        },
        proposer_acting_for: {
          kind: 'text',
          expression: (_qc, parent) =>
            sql`(select coalesce(nullif("users"."name", ''), "users"."email") from "agents" join "users" on "users"."id" = "agents"."delegated_by" where "agents"."id" = ${parent('created_by')})`,
        },
        sending_mailbox: {
          kind: 'text',
          expression: (_qc, parent) =>
            sql`(select "identities"."value" from "connections" join "identities" on "identities"."id" = "connections"."identity_id" and "identities"."organization_id" = "connections"."organization_id" where ${parent('operation')} = 'messages.send' and "connections"."id" = json_extract(${parent('arguments')}, '$.connection_id') and "connections"."organization_id" = ${parent('organization_id')} and "connections"."deleted_at" is null)`,
        },
      },
      filters: {
        status: { schema: z.enum(ACTION_REQUEST_STATUSES) },
        operation: { schema: z.string().min(1).max(100) },
        created_by: { schema: z.uuid() },
        decided_by: { schema: z.uuid() },
        contact_id: { schema: z.uuid() },
        thread_id: { schema: z.uuid() },
        interaction_id: { schema: z.uuid() },
        dedup_key: { schema: z.string().min(1).max(200) },
      },
    }),
    ['expires_at', 'decided_at'],
  ),
)
