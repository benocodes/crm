import { sql } from 'kysely'
import { z } from 'zod'
import { UnitDriftError, codecs, defineOperation, readMaybe, step, unit, type PreparedOperation } from '@vibase/storage'
import { SCOPE_POLICY, isAgentGrantable, isCustomScope, type ScopePolicy } from '../auth/roles.js'
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
 * [[CORE662]] ([[CORE630]] D10): what `agents.update` answers: the record, and `sign_in_notice`, one sentence telling the owner when the agent must sign in (or reconnect) before a scope this call added reaches it. `null` for an
 * API-key agent (it reads its record on every request) and for a call that added no scope (a removal applies at once). Only `update` carries it: `get` and `list` answer the plain record.
 */
export const agentUpdateRecord = agentRecord.extend({ sign_in_notice: z.string().nullable() })
export type AgentUpdateRecord = z.infer<typeof agentUpdateRecord>

/**
 * The notice for the scopes `added` to `agent`. An agent account's token lists only what its record held when it signed in ([[CORE630]] D11), so the notice is unconditional. A delegated agent's tokens live in the control database,
 * which no operation reads, so it is conditional in words: the connector holds the scope only if it consented to it before.
 */
function signInNotice(agent: AgentRecord, added: readonly string[]): string | null {
  if (added.length === 0) return null
  const list = added.join(', ')
  if (agent.auth_subject !== null)
    return `${list} will reach this agent when it next signs in: its current sign-in keeps only the scopes it held then. Have it run \`vibase login\` as the agent.`
  if (agent.auth_client_id !== null)
    return `${list} reaches this agent's connection only if the connector already consented to it; otherwise reconnect the connector so the person approves it.`
  return null
}

/**
 * Validates scopes for an agent ([[CORE3]] D9): every one must be declared and agent-grantable. The first
 * offender in input order decides the error. Returns the de-duplicated, sorted list.
 */
export function normalizeAgentScopes(
  scopes: readonly string[],
  policy: ScopePolicy = SCOPE_POLICY,
  declared: readonly string[] = [],
): string[] {
  for (const s of scopes) {
    // [[CORE315]] D24: a custom object's scope is known when the registry declares it (read from the registry, [[CORE630]] D10, never from the caller's own scopes).
    if (!Object.hasOwn(policy, s) && !(isCustomScope(s) && declared.includes(s)))
      throw new ApiError(400, 'unknown_scope', `unknown scope: ${s}`)
    if (!isAgentGrantable(s, policy))
      throw new ApiError(400, 'scope_not_grantable', `scope not grantable to an agent: ${s}`)
  }
  return [...new Set(scopes)].sort()
}

const name = z.string().trim().min(1).max(200)
const scopesField = z.array(z.string()).max(100)

/**
 * Agents, on the prepared path ([[CORE40]]). No delete (a table without `deleted_at`, P4). `disabled` is a hook
 * input only (P5): it drives `disabled_at` in `computed` and is never written as a column. The scope rule is
 * pure, so it runs in `prepare`; the stored list is read on every request, so a removal applies at once and a grant does too for an API key, while an agent account's sign-in lists what it held when it signed in ([[CORE662]]).
 */
export const agents = withColumnFilters(
  withColumnSorts(
    definePreparedResource({
      notProposable: 'access administration is not proposable',
      surface: 'meta',
      name: 'agents',
      eventName: 'agent',
      table: 'agents',
      scopeResource: 'agents',
      operations: ['list', 'get', 'create', 'update'],
      descriptions: {
        update:
          'Change an agent: its name, scopes (the whole list, or add_scopes and remove_scopes) or disabled flag. 409 form_principal for the agent of a form (live or deleted): that agent is managed by its form, so rename, disable or delete the form instead. When the call adds a scope to an agent that signs in, sign_in_notice says when the added scope reaches it (an agent account: when it signs in again with vibase login; a connector: only if it already consented, else reconnect it); it is null for an API-key agent, which applies at once, and when nothing was added. Example: vibase agents update <id> --disabled true',
      },
      record: agentRecord,
      updateRecord: agentUpdateRecord,
      create: z.strictObject({ name, scopes: scopesField.default([]) }),
      update: z
        .strictObject({
          name,
          scopes: scopesField,
          add_scopes: scopesField,
          remove_scopes: scopesField,
          disabled: z.boolean(),
        })
        .partial(),
      // The hook has no environment: it sorts and de-duplicates, and takes a custom object's scope on its grammar. `agents.create` and `agents.update` (the overrides) have already checked every scope against the registry's declared ones.
      prepare: ({ values }) =>
        Array.isArray(values.scopes)
          ? { scopes: normalizeAgentScopes(values.scopes as string[], SCOPE_POLICY, values.scopes as string[]) }
          : {},
      // Disabling twice keeps the first timestamp; the stamp is the unit's clock, never the database's (D2).
      computed: ({ eb, values, now }) => {
        if (values.disabled === true)
          return { disabled_at: sql<string>`coalesce(${eb.ref('agents.disabled_at')}, ${codecs.timestamp.write(now)})` }
        if (values.disabled === false) return { disabled_at: null }
        return {}
      },
      override: {
        create: (env, input) => createAgentOperation(env, input),
        update: (env, input) => updateAgentOperation(env, input as { id: string; body: unknown }),
      },
    }),
    ['name'],
  ),
)

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * `agents.update` ([[AGT186]]). Without `add_scopes`/`remove_scopes` it is the generic update, untouched (D6). With either, the validation
 * runs here, before any read (D1 combination, D2 overlap, D3 adds; existence is checked by the update itself, so an invalid body for an
 * unknown id is 400, not 404), and the new list `(stored ∪ add) \ remove` is merged inside `build` from the one `before` row whose stamp
 * guards the UPDATE (D5). A merge equal to the stored list with no `name`/`disabled` is an empty patch (D7).
 */
function planAgentUpdate(env: PreparedEnv, input: { id: string; body: unknown }): PreparedOperation<AgentRecord> {
  const values = prepareUpdate(agents, env.actor, input.body)
  const hasAdd = 'add_scopes' in values
  const hasRemove = 'remove_scopes' in values
  if (!hasAdd && !hasRemove) {
    // [[CORE315]] D24, [[CORE630]] D10: a full scope list is checked against the registry's declared scopes (not the caller's own) before the generic update's hook sorts it.
    if (Array.isArray(values.scopes)) normalizeAgentScopes(values.scopes as string[], SCOPE_POLICY, env.declaredScopes)
    return updateOperation(agents, env, input.id, input.body) as PreparedOperation<AgentRecord>
  }
  if ('scopes' in values) {
    const named = ['add_scopes', 'remove_scopes'].filter((f) => f in values).join(' and ')
    throw new ApiError(
      400,
      'validation_error',
      `scopes cannot be combined with ${named}; send either scopes or the deltas`,
    )
  }
  const add = (values.add_scopes as string[] | undefined) ?? []
  const remove = new Set((values.remove_scopes as string[] | undefined) ?? [])
  const overlap = add.find((s) => remove.has(s))
  if (overlap !== undefined)
    throw new ApiError(400, 'validation_error', `add_scopes and remove_scopes both name ${overlap}`)
  const added = normalizeAgentScopes(add, SCOPE_POLICY, env.declaredScopes)
  const touchesOther = 'name' in values || 'disabled' in values
  return updateOperation(agents, env, input.id, input.body, (before) => {
    const next = [...new Set([...before.scopes, ...added])].filter((s) => !remove.has(s)).sort()
    if (!touchesOther && sameList(next, before.scopes)) return null
    return { scopes: next }
  }) as PreparedOperation<AgentRecord>
}

/**
 * `agents.update` for every body shape, refusing the principal of a form ([[CHN423]] D4, P1 to P3): `409 form_principal` when the agent's id is a `forms` row, live or soft-deleted. The check comes after the body validation
 * (`planAgentUpdate` throws 400 first) and after the existence check (its `build` throws 404 first), and before any write; the agent and its form are written in one unit, so no guard is needed (P3). The form read rides the same plan phase.
 */
export function updateAgentOperation(
  env: PreparedEnv,
  input: { id: string; body: unknown },
): PreparedOperation<AgentUpdateRecord> {
  const inner = planAgentUpdate(env, input)
  const id = input.id.toLowerCase()
  return defineOperation<AgentUpdateRecord>({
    ...inner,
    reads: (qc) => ({
      ...inner.reads(qc),
      form: readMaybe(
        qc.db
          .selectFrom('forms')
          .select('forms.id')
          .where('forms.id', '=', id)
          .where('forms.organization_id', '=', env.organizationId),
      ),
    }),
    build: (found, qc) => {
      const built = inner.build(found, qc) // 404 for an unknown agent comes first
      if (found.maybe('form') !== null)
        throw new ApiError(409, 'form_principal', `managed by form ${id}; change the form`)
      // [[CORE662]] D10: the scopes this call added, against the row the write was planned on.
      const { __stamp, ...rest } = found.maybe('before') as Record<string, unknown>
      const before = toRecord(agents, rest) as AgentRecord
      return {
        ...built,
        decode: (rows, f) => {
          const after = built.decode(rows, f)
          return {
            ...after,
            sign_in_notice: signInNotice(
              after,
              after.scopes.filter((s) => !before.scopes.includes(s)),
            ),
          }
        },
      }
    },
  })
}

/**
 * `agents.create` (P13): the principal first, without RETURNING (no SELECT policy admits it until its agents row
 * exists, [[CORE27]] P4), then the agents row, `agent.created` and the result. Four statements, constant.
 */
export function createAgentOperation(env: PreparedEnv, input: unknown): PreparedOperation<AgentRecord> {
  const values = prepareCreate(agents, env.actor, input)
  const scopes = normalizeAgentScopes(values.scopes as string[], SCOPE_POLICY, env.declaredScopes)
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
