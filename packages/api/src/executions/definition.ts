import { z } from 'zod'
import { defineOperation, memberOf, readAll, readMaybe, unit, type PreparedOperation, type Read } from '@vault/storage'
import { ApiError } from '../errors.js'
import type { Registry, TenantOperation } from '../registry.js'
import { selectRecord, toRecord } from '../storage/crud.js'
import { definePreparedResource, type PreparedEnv } from '../storage/definition.js'
import { canonicalId, prepareListQuery } from '../storage/prepare.js'

export const EXECUTION_STATUSES = ['queued', 'claimed', 'done', 'failed'] as const

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  operation: z.string().describe('The enqueued operation this executes, for example messages.send.'),
  status: z.enum(EXECUTION_STATUSES).describe('queued (waiting or between attempts), claimed (an attempt is running), done or failed.'),
  arguments: z.record(z.string(), z.unknown()).describe('The operation\'s final arguments, fixed when it was authorised.'),
  action_request_id: z.uuid().nullable().describe('The approved action request this executes; null for a direct call.'),
  created_by: z.uuid().describe('The principal that asked: the proposer for an approved request, the caller for a direct call.'),
  authorised_by: z.uuid().describe('The principal whose authority it runs under: the approver, or the caller for a direct call.'),
  idempotency_key: z.string().nullable().describe('The caller\'s key of a direct call; null for an approved request.'),
  result: z.unknown().describe('What the operation produced; null until done.'),
  error_code: z.string().nullable().describe('Why it failed: reauth_required, permission_missing, anchor_missing, provider_rejected, outcome_unknown, attempts_exhausted or deadline_passed.'),
  error_message: z.string().nullable().describe('The vault\'s sentence for the failure; never a provider\'s own text.'),
  deadline_at: z.string().describe('When a never-attempted execution stops being attempted.'),
  done_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ExecutionRecord = z.infer<typeof record>

/**
 * The execution resource ([[AGT8]] D11, D56, D57): a durable record of one run of an enqueued operation. Its record holds the safe columns only; the lease
 * columns, the input hash, the resolution and the client reference stay in the table. It declares no generated operations: its two reads are
 * hand-written because their visibility is the enqueued operation's own read scope (`executionReadOperations`), not a scope of the table.
 */
export const actionExecutions = definePreparedResource({
  notProposable: 'executions are created by authorising an enqueued operation, never written directly',
  surface: 'api',
  name: 'action_executions',
  eventName: 'action_execution',
  table: 'action_executions',
  d1Only: true,
  operations: [],
  record,
  filters: {
    status: { schema: z.enum(EXECUTION_STATUSES) },
    operation: { schema: z.string().min(1).max(100) },
    action_request_id: { schema: z.uuid() },
  },
})

const notFound = () => new ApiError(404, 'not_found', 'action execution not found')

/** The enqueued operations whose executions this caller may read ([[AGT8]] D57): the read scope each one declares. */
export function readableOperations(registry: Registry, env: PreparedEnv): string[] {
  return registry
    .operations()
    .filter((o): o is TenantOperation => o.kind === 'tenant' && o.execution !== undefined && env.scopes.has(o.execution.readScope))
    .map((o) => o.name)
}

type Page = { data: ExecutionRecord[]; next_cursor: string | null }

function listExecutions(registry: Registry, env: PreparedEnv, query: Record<string, unknown>): PreparedOperation<Page> {
  const { after, limit, filters } = prepareListQuery(actionExecutions, { after: query.after, limit: query.limit, filters: Object.fromEntries(Object.entries(query).filter(([k, v]) => !['after', 'limit'].includes(k) && v !== undefined)) as Record<string, string> })
  const allowed = readableOperations(registry, env)
  return defineOperation<Page>({
    name: 'action_executions.list',
    mutates: false,
    reads: (qc): Record<string, Read> => {
      if (allowed.length === 0) return {}
      let q = selectRecord(actionExecutions, qc, env).where(memberOf(qc, 'action_executions', 'operation', allowed))
      if (after) q = q.where('action_executions.id', '>', after as never)
      for (const [column, value] of Object.entries(filters)) q = q.where(`action_executions.${column}` as never, '=', value as never)
      return { page: readAll(q.orderBy('action_executions.id', 'asc').limit(limit + 1)) }
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const rows = allowed.length === 0 ? [] : found.all('page')
          const page = rows.slice(0, limit)
          return { data: page.map((r) => toRecord(actionExecutions, r)), next_cursor: rows.length > limit ? (page[page.length - 1]!.id as string) : null }
        },
      }),
  })
}

function getExecution(registry: Registry, env: PreparedEnv, rawId: string): PreparedOperation<ExecutionRecord> {
  // A malformed id, an unreadable one and a missing one are the same 404 (D57).
  const id = canonicalId(actionExecutions, rawId)
  const allowed = readableOperations(registry, env)
  return defineOperation<ExecutionRecord>({
    name: 'action_executions.get',
    mutates: false,
    reads: (qc): Record<string, Read> => (allowed.length === 0 ? {} : { row: readMaybe(selectRecord(actionExecutions, qc, env, id).where(memberOf(qc, 'action_executions', 'operation', allowed))) }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const row = allowed.length === 0 ? null : found.maybe('row')
          if (!row) throw notFound()
          return toRecord(actionExecutions, row)
        },
      }),
  })
}

/**
 * `action_executions.list` and `.get` ([[AGT8]] D57). They carry no scope of their own and add none to the catalog: a caller sees an execution when it holds the
 * read scope its operation declares (`messages:read` for `messages.send`), so with no enqueued operation registered every list is empty.
 */
export function executionReadOperations(registry: Registry): TenantOperation[] {
  const base = { kind: 'tenant' as const, surface: 'api' as const, d1Only: true, tags: ['action_executions'], scope: null, authority: 'read' as const, validation: 'handler' as const }
  return [
    {
      ...base,
      name: 'action_executions.list',
      summary: 'List action executions',
      description: 'The durable executions of enqueued operations, oldest id first. You see an execution when you hold the read scope its operation declares (for example messages:read for messages.send); the list is empty otherwise.',
      method: 'get',
      path: '/action-executions',
      request: {
        query: z.object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          status: z.enum(EXECUTION_STATUSES).optional(),
          operation: z.string().min(1).max(100).optional(),
          action_request_id: z.uuid().optional(),
        }),
      },
      response: { status: 200, schema: z.object({ data: z.array(record), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => listExecutions(registry, env, input.query),
    },
    {
      ...base,
      name: 'action_executions.get',
      summary: 'Get an action execution',
      description: 'One execution: its status, arguments, who asked and who authorised it, and its result or classified failure. An execution you may not read is 404, as a missing one is.',
      method: 'get',
      path: '/action-executions/{id}',
      request: { params: z.object({ id: z.uuid() }) },
      response: { status: 200, schema: record },
      prepare: (env, input) => getExecution(registry, env, input.params.id as string),
    },
  ]
}
