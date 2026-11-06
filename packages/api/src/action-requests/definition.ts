import { sql } from 'kysely'
import { z } from 'zod'
import { definePreparedResource } from '../storage/definition.js'

export const ACTION_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded', 'executed', 'failed'] as const
export const evidenceItem = z.strictObject({ type: z.enum(['message', 'interaction']), id: z.uuid() })

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  operation: z.string().describe('The registered operation proposed, for example tasks.update.'),
  arguments: z.record(z.string(), z.unknown()).describe('The operation\'s flat arguments as proposed (the MCP shape: path, query and body fields in one object). Never changed after creation.'),
  edited_arguments: z.record(z.string(), z.unknown()).nullable().describe('The complete replacement arguments a reviewer approved instead; null unless approved with an edit.'),
  status: z.enum(ACTION_REQUEST_STATUSES),
  reason: z.string(),
  evidence: z.array(evidenceItem),
  contact_id: z.uuid().nullable(),
  thread_id: z.uuid().nullable(),
  interaction_id: z.uuid().nullable(),
  dedup_key: z.string().nullable(),
  expires_at: z.string(),
  decided_by: z.uuid().nullable().describe('The principal (user or agent) that decided it; the system principal for an expiry.'),
  decided_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  superseded_by_id: z.uuid().nullable(),
  result: z.unknown().describe('What approval did: for an inline operation { events: [{ type, resource_type, resource_id }] }, the events it wrote; for a queued one the execution\'s result. Null until executed.'),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  executed_at: z.string().nullable(),
  execution_id: z.uuid().nullable().optional().describe('The execution a queued approval created; absent or null until then and for operations that run inline.'),
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
export const actionRequests = definePreparedResource({
  notProposable: 'action requests are decided through action_requests.approve and action_requests.reject, never proposed',
  surface: 'api',
  name: 'action_requests',
  eventName: 'action_request',
  table: 'action_requests',
  d1Only: true,
  operations: ['list', 'get'],
  record,
  // [[AGT8]] D48: the request reads its execution through the execution's own link; `action_requests` stores no copy.
  derived: {
    execution_id: {
      kind: 'text',
      expression: (_qc, parent) => sql`(select "action_executions"."id" from "action_executions" where "action_executions"."action_request_id" = ${parent('id')})`,
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
})
