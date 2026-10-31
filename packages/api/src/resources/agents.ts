import { sql } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, codecs, defineOperation, step, unit, type PreparedOperation } from '@vault/storage'
import { SCOPE_POLICY, isAgentGrantable, type ScopePolicy } from '../auth/roles.js'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { columnsOf, receipt, resultStep, toRecord } from '../storage/crud.js'
import { definePreparedResource, type PreparedEnv } from '../storage/definition.js'
import { prepareCreate } from '../storage/prepare.js'

export const agentRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  disabled_at: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type AgentRecord = z.infer<typeof agentRecord>

/**
 * Validates scopes for an agent ([[CORE3]] D9): every one must be declared and agent-grantable. The first
 * offender in input order decides the error. Returns the de-duplicated, sorted list.
 */
export function normalizeAgentScopes(scopes: readonly string[], policy: ScopePolicy = SCOPE_POLICY): string[] {
  for (const s of scopes) {
    if (!Object.hasOwn(policy, s)) throw new ApiError(400, 'unknown_scope', `unknown scope: ${s}`)
    if (!isAgentGrantable(s, policy)) throw new ApiError(400, 'scope_not_grantable', `scope not grantable to an agent: ${s}`)
  }
  return [...new Set(scopes)].sort()
}

const name = z.string().trim().min(1).max(200)
const scopesField = z.array(z.string()).max(100)

/**
 * Agents, on the prepared path ([[CORE40]]). No delete (a table without `deleted_at`, P4). `disabled` is a hook
 * input only (P5): it drives `disabled_at` in `computed` and is never written as a column. The scope rule is
 * pure, so it runs in `prepare`; a scope change applies at once because the next request reads the stored list.
 */
export const agents = definePreparedResource({
  surface: 'meta',
  name: 'agents',
  eventName: 'agent',
  table: 'agents',
  scopeResource: 'agents',
  operations: ['list', 'get', 'create', 'update'],
  record: agentRecord,
  create: z.strictObject({ name, scopes: scopesField.default([]) }),
  update: z.strictObject({ name, scopes: scopesField, disabled: z.boolean() }).partial(),
  prepare: ({ values }) => (Array.isArray(values.scopes) ? { scopes: normalizeAgentScopes(values.scopes as string[]) } : {}),
  // Disabling twice keeps the first timestamp; the stamp is the unit's clock, never the database's (D2).
  computed: ({ eb, values, now }) => {
    if (values.disabled === true) return { disabled_at: sql<string>`coalesce(${eb.ref('agents.disabled_at')}, ${codecs.timestamp.write(now)})` }
    if (values.disabled === false) return { disabled_at: null }
    return {}
  },
  override: { create: (env, input) => createAgentOperation(env, input) },
})

/**
 * `agents.create` (P13): the principal first, without RETURNING (no SELECT policy admits it until its agents row
 * exists, [[CORE27]] P4), then the agents row, `agent.created` and the result. Four statements, constant.
 */
export function createAgentOperation(env: PreparedEnv, input: unknown): PreparedOperation<AgentRecord> {
  const values = prepareCreate(agents, env.actor, input)
  const scopes = normalizeAgentScopes(values.scopes as string[])
  const id = env.newId()
  const eventId = env.newId()
  const at = codecs.timestamp.write(env.now)
  return defineOperation<AgentRecord>({
    name: 'agents.create',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(qc.db.insertInto('principals').values({ id, kind: 'agent', created_at: at }), 'first-mutation'),
          step(
            qc.db.insertInto('agents').values({
              id,
              created_at: at,
              updated_at: at,
              organization_id: env.organizationId,
              name: values.name as string,
              scopes,
              disabled_at: null,
              created_by: env.actor.id,
            }),
          ),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: env.organizationId,
              actorId: env.actor.id,
              type: 'agent.created',
              resourceType: 'agent',
              resourceId: id,
              before: null,
              after: { table: 'agents', columns: columnsOf(agents) },
            }),
            'first-event',
          ),
          resultStep(agents, qc, env, id, eventId),
        ],
        events: [receipt(agents, eventId, 'created', id)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('agents.create')
          return toRecord(agents, rows[0]!)
        },
      }),
  })
}
