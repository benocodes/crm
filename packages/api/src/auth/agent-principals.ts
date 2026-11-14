import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, assertStep, codecs, defineOperation, execute, readMaybe, step, unit, type PreparedOperation, type Read, type Step, type StorageBinding } from '@vibase/storage'
import { ApiError, mapStorageError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { SYSTEM_PRINCIPAL_READ, systemPrincipalRead, systemPrincipalSteps } from '../directory/system-principal.js'
import { agents } from '../resources/agents.js'
import { columnsOf, receipt } from '../storage/crud.js'
import { admittedRole, membershipRoleRead } from './membership-role.js'
import type { Role } from './roles.js'
import type { InternalEnv } from '../storage/internal.js'

/** An agent principal found or created for a token: its id, the stored grants (or cap) and whether it is disabled. */
export type AgentLogin = { agentId: string; scopes: string[]; disabled: boolean }
/** What the vault already holds for a token's subject: the human's id, the agent account linked to the subject, the delegated agent for (client, human). */
export type PrincipalLookup = {
  userId: string | null
  account: AgentLogin | null
  delegated: AgentLogin | null
  /** Only when the lookup asked for it (`organizationId` given: the built-in provider, [[CORE244]] D7): the live membership's role in that organisation, `null` when none or not admitted. */
  membershipRole?: Role | null
}

const INTERNAL = { kind: 'internal', organizationId: null } as const
const USER = 'principal:user'
const ACCOUNT = 'principal:account'
const DELEGATED = 'principal:delegated'
const MEMBERSHIP = 'principal:membership'
const AGENT_COLUMNS = ['agents.id as agent_id', 'agents.scopes', 'agents.disabled_at'] as const

type Row = Record<string, unknown>
const loginOf = (row: Row | null): AgentLogin | null =>
  row ? { agentId: row.agent_id as string, scopes: codecs.stringArray.read(row.scopes), disabled: codecs.timestamp.readNullable(row.disabled_at) !== null } : null

/**
 * The steady-state lookup ([[CORE77]] D14): ONE read-only internal unit answering, for a token's subject, whether a `users` row exists, whether an
 * agent account is linked to the subject (D17) and, when the token's client is not the first-party CLI, whether the delegated agent for
 * (client, human) exists (D15). Reads only; the three answers decide the principal kind.
 */
export function lookupPrincipalOperation(a: { provider: string; subject: string; clientId: string | null; organizationId?: string }): PreparedOperation<PrincipalLookup> {
  return defineOperation<PrincipalLookup>({
    name: 'auth.lookup_principal',
    mutates: false,
    reads: (qc) => {
      const reads: Record<string, Read> = {
        [USER]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', a.provider).where('users.auth_subject', '=', a.subject)),
        [ACCOUNT]: readMaybe(qc.db.selectFrom('agents').select([...AGENT_COLUMNS]).where('agents.auth_provider', '=', a.provider).where('agents.auth_subject', '=', a.subject)),
      }
      if (a.clientId !== null) {
        reads[DELEGATED] = readMaybe(
          qc.db
            .selectFrom('agents')
            .innerJoin('users', 'users.id', 'agents.delegated_by')
            .select([...AGENT_COLUMNS])
            .where('agents.auth_provider', '=', a.provider)
            .where('agents.auth_client_id', '=', a.clientId)
            .where('users.auth_provider', '=', a.provider)
            .where('users.auth_subject', '=', a.subject),
        )
      }
      if (a.organizationId !== undefined) reads[MEMBERSHIP] = membershipRoleRead(qc, { provider: a.provider, subject: a.subject, organizationId: a.organizationId })
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => ({
          userId: (found.maybe(USER)?.id as string | undefined) ?? null,
          account: loginOf(found.maybe(ACCOUNT)),
          delegated: loginOf(found.maybe(DELEGATED)),
          ...(a.organizationId !== undefined ? { membershipRole: admittedRole(found.maybe(MEMBERSHIP)?.role) } : {}),
        }),
      }),
  })
}

export async function lookupPrincipal(storage: StorageBinding, a: { provider: string; subject: string; clientId: string | null; organizationId?: string }): Promise<PrincipalLookup> {
  try {
    return (await execute(storage, INTERNAL, lookupPrincipalOperation(a))).value
  } catch (err) {
    throw mapStorageError(err)
  }
}

type NewAgent = {
  organizationId: string
  provider: string
  name: string
  scopes: readonly string[]
  /** The columns that link the agent to the provider: `{ auth_subject }` or `{ auth_client_id, delegated_by }`. */
  link: { auth_subject: string } | { auth_client_id: string; delegated_by: string }
  /** The principal the creation is attributed to: the human who consented (D15) or `system` (D17, null: look it up and create it if absent). */
  createdBy: string | null
  agentId: string
  eventId: string
  systemId: string
  now: Date
}

const KEY = 'agent:existing'

/**
 * First sight of an agent principal ([[CORE77]] D15, D17): ONE internal unit. The principal, the `agents` row with INSERT ... ON CONFLICT DO NOTHING
 * on the link's partial unique index (invariant 3: never a caught 23505), the `agent.created` event (gated on that insert having applied, so
 * a race loser writes none), and an assertion that the stored agent for the link carries THIS id. The loser drifts, the unit rolls back
 * (no orphan principal, no event) and the caller re-reads. Nothing gated on `changes()` follows the assertion, only the ungated result select.
 */
export function createAgentPrincipalOperation(a: NewAgent): PreparedOperation<AgentLogin> {
  const at = codecs.timestamp.write(a.now)
  const linkColumns = a.link
  const linkMatches = 'auth_subject' in linkColumns
    ? sql<SqlBool>`"agents"."auth_subject" = ${linkColumns.auth_subject}`
    : sql<SqlBool>`"agents"."auth_client_id" = ${linkColumns.auth_client_id} and "agents"."delegated_by" = ${linkColumns.delegated_by}`
  return defineOperation<AgentLogin>({
    name: a.createdBy === null ? 'auth.first_sight_agent_account' : 'auth.first_sight_delegated_agent',
    mutates: true,
    reads: (qc): Record<string, Read> => (a.createdBy === null ? { [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc) } : {}),
    build: (found, qc) => {
      const sys = a.createdBy === null ? systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.systemId, at) : { id: a.createdBy, steps: [] as Step[] }
      const insert = qc.db
        .insertInto('agents')
        .values({
          id: a.agentId,
          created_at: at,
          updated_at: at,
          organization_id: a.organizationId,
          name: a.name,
          scopes: [...a.scopes],
          disabled_at: null,
          created_by: sys.id,
          auth_provider: a.provider,
          auth_subject: null,
          auth_client_id: null,
          delegated_by: null,
          ...linkColumns,
        })
        .onConflict((oc) => oc.doNothing())
      const holds = sql<SqlBool>`exists (select 1 from "agents" where "agents"."auth_provider" = ${a.provider} and ${linkMatches} and "agents"."id" = ${a.agentId})`
      const result = qc.db.selectFrom('agents').select([...AGENT_COLUMNS]).where('agents.id', '=', a.agentId)
      const steps: Step[] = [
        ...sys.steps,
        step(qc.db.insertInto('principals').values({ id: a.agentId, kind: 'agent', created_at: at })),
        step(insert),
        { ...step(eventStatement(qc, { id: a.eventId, at, organizationId: a.organizationId, actorId: sys.id, type: 'agent.created', resourceType: 'agent', resourceId: a.agentId, before: null, after: { table: 'agents', columns: columnsOf(agents) } })), label: 'first-event' },
        assertStep(qc, holds),
        { ...step(result), label: 'result' },
      ]
      steps[0] = { ...steps[0]!, label: 'first-mutation' }
      return unit({
        steps,
        events: [receipt(agents, a.eventId, 'created', a.agentId)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('auth.first_sight_agent')
          return loginOf(rows[0] as Row)!
        },
      })
    },
  })
}

/**
 * Creates the agent, or returns the winner's when two first sights race: on drift ONE read-only recheck ([[CORE36]] D18's pattern); when even
 * that finds nothing the answer is `409 conflict`.
 */
export async function provisionAgent(
  storage: StorageBinding,
  env: InternalEnv,
  a: { provider: string; subject: string; clientId: string | null; kind: 'account' | 'delegated'; name: string; scopes: readonly string[]; humanId: string | null; organizationId: string },
): Promise<AgentLogin> {
  const link = a.kind === 'account' ? { auth_subject: a.subject } : { auth_client_id: a.clientId!, delegated_by: a.humanId! }
  const op = createAgentPrincipalOperation({
    organizationId: a.organizationId,
    provider: a.provider,
    name: a.name.slice(0, 200),
    scopes: a.scopes,
    link,
    createdBy: a.kind === 'account' ? null : a.humanId,
    agentId: env.newId(),
    eventId: env.newId(),
    systemId: env.newId(),
    now: env.now,
  })
  try {
    return (await execute(storage, INTERNAL, op)).value
  } catch (err) {
    if (!(err instanceof UnitDriftError)) throw mapStorageError(err)
  }
  const again = await lookupPrincipal(storage, { provider: a.provider, subject: a.subject, clientId: a.kind === 'delegated' ? a.clientId : null })
  const found = a.kind === 'account' ? again.account : again.delegated
  if (!found) throw new ApiError(409, 'conflict', 'the record changed while the operation was running; retry')
  return found
}
