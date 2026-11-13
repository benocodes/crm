import { sql } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, codecs, defineOperation, step, unit, type PreparedOperation } from '@vibase/storage'
import { SCOPE_POLICY, isAgentGrantable, type ScopePolicy } from '../auth/roles.js'
import { ApiError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { columnsOf, receipt, resultStep, toRecord, updateOperation } from '../storage/crud.js'
import { definePreparedResource, type PreparedEnv } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { prepareCreate, prepareUpdate } from '../storage/prepare.js'

export const agentRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  disabled_at: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  /** How the agent is linked to the sign-in provider ([[CORE77]] D23); all null for an API-key agent. */
  auth_provider: z.string().nullable(),
  /** An agent account: the provider user whose role is `agent`. */
  auth_subject: z.string().nullable(),
  /** A delegated agent: the OAuth client the human consented to. */
  auth_client_id: z.string().nullable(),
  /** A delegated agent: the human who consented. */
  delegated_by: z.uuid().nullable(),
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
export const agents = withColumnFilters(withColumnSorts(definePreparedResource({
  notProposable: 'access administration is not proposable',
  surface: 'meta',
  name: 'agents',
  eventName: 'agent',
  table: 'agents',
  scopeResource: 'agents',
  operations: ['list', 'get', 'create', 'update'],
  record: agentRecord,
  create: z.strictObject({ name, scopes: scopesField.default([]) }),
  update: z.strictObject({ name, scopes: scopesField, add_scopes: scopesField, remove_scopes: scopesField, disabled: z.boolean() }).partial(),
  prepare: ({ values }) => (Array.isArray(values.scopes) ? { scopes: normalizeAgentScopes(values.scopes as string[]) } : {}),
  // Disabling twice keeps the first timestamp; the stamp is the unit's clock, never the database's (D2).
  computed: ({ eb, values, now }) => {
    if (values.disabled === true) return { disabled_at: sql<string>`coalesce(${eb.ref('agents.disabled_at')}, ${codecs.timestamp.write(now)})` }
    if (values.disabled === false) return { disabled_at: null }
    return {}
  },
  override: {
    create: (env, input) => createAgentOperation(env, input),
    update: (env, input) => updateAgentOperation(env, input as { id: string; body: unknown }),
  },
}), ['name']))

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * `agents.update` ([[AGT186]]). Without `add_scopes`/`remove_scopes` it is the generic update, untouched (D6). With either, the validation
 * runs here, before any read (D1 combination, D2 overlap, D3 adds; existence is checked by the update itself, so an invalid body for an
 * unknown id is 400, not 404), and the new list `(stored ∪ add) \ remove` is merged inside `build` from the one `before` row whose stamp
 * guards the UPDATE (D5). A merge equal to the stored list with no `name`/`disabled` is an empty patch (D7).
 */
export function updateAgentOperation(env: PreparedEnv, input: { id: string; body: unknown }): PreparedOperation<AgentRecord> {
  const values = prepareUpdate(agents, env.actor, input.body)
  const hasAdd = 'add_scopes' in values
  const hasRemove = 'remove_scopes' in values
  if (!hasAdd && !hasRemove) return updateOperation(agents, env, input.id, input.body) as PreparedOperation<AgentRecord>
  if ('scopes' in values) {
    const named = ['add_scopes', 'remove_scopes'].filter((f) => f in values).join(' and ')
    throw new ApiError(400, 'validation_error', `scopes cannot be combined with ${named}; send either scopes or the deltas`)
  }
  const add = (values.add_scopes as string[] | undefined) ?? []
  const remove = new Set((values.remove_scopes as string[] | undefined) ?? [])
  const overlap = add.find((s) => remove.has(s))
  if (overlap !== undefined) throw new ApiError(400, 'validation_error', `add_scopes and remove_scopes both name ${overlap}`)
  const added = normalizeAgentScopes(add)
  const touchesOther = 'name' in values || 'disabled' in values
  return updateOperation(agents, env, input.id, input.body, (before) => {
    const next = [...new Set([...before.scopes, ...added])].filter((s) => !remove.has(s)).sort()
    if (!touchesOther && sameList(next, before.scopes)) return null
    return { scopes: next }
  }) as PreparedOperation<AgentRecord>
}

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
