// The apply side of the hq auth migration ([[OPS392]], [[OPS250]] D1, D3, D4, D13): given the plan file, a fresh export and the two databases, the control batch (inert `auth_users` rows) and then the CRM batch (the commit point:
// users and agent accounts re-pointed to Better Auth, delegated agents disabled, memberships inserted, one unit). It refuses a plan the instance no longer matches before it writes anything.
// The batches are reached through `applyBatches` over two `D1Like` handles; opening the remote databases and the provider switch are #393's, so the CLI's real run is dormant (P1).
import { sql, type SqlBool } from 'kysely'
import {
  CommitOutcomeUnknown,
  StorageError,
  UnitDriftError,
  assertStep,
  codecs,
  defineOperation,
  exactly,
  readMaybe,
  recordColumns,
  step,
  unit,
  type EventReceipt,
  type QueryContext,
  type Read,
  type Step,
} from '@vibase/storage'
import {
  agentRecord,
  eventStatement,
  membershipRecord,
  systemPrincipalRead,
  systemPrincipalSteps,
  SYSTEM_PRINCIPAL_READ,
} from '@vibase/api'
import { createD1Runtime, type D1Like } from '@vibase/storage-d1'
import type { AgentRow, AuthPlan, ClerkUserRow, PlanAgent, PlanPerson, Snapshot } from './types.js'

/** Refused: nothing was written by this run (the control batch's read-back refusal, P4, may follow inert rows an earlier run wrote). */
export class ApplyRefusal extends Error {}
/** Failed after a write began: the run's outcome is the databases' state, and a re-run reads it back (P2). */
export class ApplyFailure extends Error {}
export const EXIT_REFUSED = 1
/** Failed after a write began; distinct from a refusal's 1 so an operator knows to look at the state first. */
export const EXIT_FAILED_AFTER_WRITE = 2
export const exitCodeFor = (e: unknown): number => (e instanceof ApplyFailure ? EXIT_FAILED_AFTER_WRITE : EXIT_REFUSED)

export type ApplyState = 'not_applied' | 'applied'
export interface ApplyOptions {
  plan: AuthPlan
  /** A fresh export of the instance, normalized as the plan's snapshot is. */
  fresh: Snapshot
  crm: D1Like
  control: D1Like
  now(): Date
  newId(): string
}
export interface ApplyOutcome {
  state: ApplyState
  control_inserted: number
  users_repointed: number
  agents_relinked: number
  agents_disabled: number
  memberships_inserted: number
}
const PROVIDER = 'better-auth'

// ---- the state check (D3, P2, P5) -------------------------------------------------------------------------

type Row = Record<string, unknown>
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Row).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  )

/** The ids whose rows differ between two lists (changed, missing or extra), named with `label`. */
function diffRows<T extends object>(
  label: (r: T) => string,
  key: (r: T) => string,
  a: readonly T[],
  b: readonly T[],
): string[] {
  const left = new Map(a.map((r) => [key(r), r]))
  const right = new Map(b.map((r) => [key(r), r]))
  const out: string[] = []
  for (const k of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const l = left.get(k)
    const r = right.get(k)
    if (!l || !r || canon(l) !== canon(r)) out.push(label((l ?? r)!))
  }
  return out
}
const clerkLabel = (r: ClerkUserRow) => `Clerk user ${r.id}`
const userLabel = (r: Row) => `users row ${r.id}`
const agentLabel = (r: Row) => `agents row ${r.id}`
const membershipLabel = (r: Row) => `membership ${r.id} (user ${r.user_id})`

const diffsAgainst = (expected: Snapshot, fresh: Snapshot): string[] => [
  ...diffRows(clerkLabel, (r) => r.id, expected.clerk_users, fresh.clerk_users),
  ...diffRows(userLabel, (r) => r.id as string, expected.users as unknown as Row[], fresh.users as unknown as Row[]),
  ...diffRows(agentLabel, (r) => r.id as string, expected.agents as unknown as Row[], fresh.agents as unknown as Row[]),
  ...diffRows(
    membershipLabel,
    (r) => r.id as string,
    expected.memberships as unknown as Row[],
    fresh.memberships as unknown as Row[],
  ),
]

const migrating = (plan: AuthPlan): PlanPerson[] => plan.people.filter((p) => p.action === 'migrate')
const needsMembership = (p: PlanPerson): p is PlanPerson & { role: 'owner' | 'member' } =>
  p.action === 'migrate' && p.role !== null && p.membership === null

/** The snapshot with the plan applied, except what the plan cannot know: a disabled agent's `disabled_at` stamp and a new membership's id (both compared by shape below). */
function appliedSnapshot(plan: AuthPlan): Snapshot {
  const s = structuredClone(plan.snapshot)
  for (const p of migrating(plan)) {
    const u = s.users.find((x) => x.id === p.user_id)!
    u.auth_provider = PROVIDER
    u.auth_subject = p.new_auth_user_id
  }
  for (const a of plan.agents) {
    const row = s.agents.find((x) => x.id === a.id)!
    if (a.action === 'relink') {
      row.auth_provider = PROVIDER
      row.auth_subject = a.new_auth_user_id
    }
    if (a.action === 'disable') row.disabled_at = DISABLED_MARK
  }
  return s
}
const DISABLED_MARK = '<disabled by the plan>'

function appliedDiffs(plan: AuthPlan, fresh: Snapshot): string[] {
  const expected = appliedSnapshot(plan)
  const disabled = new Set(plan.agents.filter((a) => a.action === 'disable').map((a) => a.id))
  const seen: Snapshot = {
    ...fresh,
    agents: fresh.agents.map((a) =>
      disabled.has(a.id) && a.disabled_at !== null ? { ...a, disabled_at: DISABLED_MARK } : a,
    ),
    memberships: [],
  }
  const out = diffsAgainst({ ...expected, memberships: [] }, seen)
  // Memberships: the snapshot's, plus one live row per person the plan gives one, matched by shape (the new ids are not in the plan).
  const shape = (m: { user_id: string; role: string; deleted_at: string | null }) =>
    `${m.user_id}|${m.role}|${m.deleted_at}`
  const want = new Map<string, number>()
  const add = (k: string, n: number) => want.set(k, (want.get(k) ?? 0) + n)
  for (const m of plan.snapshot.memberships) add(shape(m), 1)
  for (const p of plan.people.filter(needsMembership))
    add(shape({ user_id: p.user_id, role: p.role, deleted_at: null }), 1)
  for (const m of fresh.memberships) add(shape(m), -1)
  for (const [k, n] of [...want].sort()) if (n !== 0) out.push(`membership of user ${k.split('|')[0]}`)
  return out
}

/**
 * Which of the three states the instance is in (P2): the fresh export equals the snapshot (`not_applied`), or the snapshot with the plan applied (`applied`), or it is a mismatch (a refusal naming the differing rows by id).
 * A plan whose person has a live membership of another role than the plan gives is refused too (P5). Strict: a changed name counts.
 */
export function assessState(plan: AuthPlan, fresh: Snapshot): ApplyState {
  const fromSnapshot = diffsAgainst(plan.snapshot, fresh)
  if (fromSnapshot.length === 0) {
    for (const p of migrating(plan))
      if (p.role !== null && p.membership !== null && p.membership.role !== p.role)
        throw new ApplyRefusal(
          `person ${p.user_id} has a live ${p.membership.role} membership but Clerk gives the role ${p.role}: the vault does not change a role here; resolve it, then plan again`,
        )
    return 'not_applied'
  }
  const fromApplied = appliedDiffs(plan, fresh)
  if (fromApplied.length === 0) return 'applied'
  const named = fromApplied.length < fromSnapshot.length ? fromApplied : fromSnapshot
  throw new ApplyRefusal(`the instance no longer matches the plan: ${named.join('; ')}. Plan again.`)
}

// ---- what a dry run says ----------------------------------------------------------------------------------

interface Counts {
  controlPeople: number
  controlAgents: number
  users: number
  relinked: number
  disabled: number
  memberships: number
}
function countsOf(plan: AuthPlan): Counts {
  const people = migrating(plan)
  return {
    controlPeople: people.length,
    controlAgents: plan.agents.filter((a) => a.action === 'relink').length,
    users: people.length,
    relinked: plan.agents.filter((a) => a.action === 'relink').length,
    disabled: plan.agents.filter((a) => a.action === 'disable').length,
    memberships: plan.people.filter(needsMembership).length,
  }
}
/** Counts per action, no personal data. */
export function describePlan(plan: AuthPlan): string[] {
  const c = countsOf(plan)
  return [
    `control batch: ${c.controlPeople + c.controlAgents} auth_users rows (${c.controlPeople} people, ${c.controlAgents} agent account${c.controlAgents === 1 ? '' : 's'})`,
    `CRM batch: users re-pointed: ${c.users}, agents relinked: ${c.relinked}, agents disabled: ${c.disabled}, memberships inserted: ${c.memberships}`,
  ]
}

// ---- the control batch (D1, D4, P4) -----------------------------------------------------------------------

interface ControlRow {
  id: string
  name: string
  email: string
  verified: boolean
}
/** One row per migrate person and per relink agent: the plan's id, the vault's address (Clerk's, lower-cased, for an agent account), the name (else the address) and a verified flag only when Clerk verified that very address. */
function controlRows(plan: AuthPlan): ControlRow[] {
  const clerk = new Map(plan.snapshot.clerk_users.map((u) => [u.id, u]))
  const out: ControlRow[] = []
  for (const p of migrating(plan)) {
    const u = plan.snapshot.users.find((x) => x.id === p.user_id)!
    const c = clerk.get(p.old_subject!)
    out.push({
      id: p.new_auth_user_id!,
      name: u.name ?? u.email,
      email: u.email,
      verified: c?.email != null && c.email_verified && c.email.toLowerCase() === u.email.toLowerCase(),
    })
  }
  for (const a of plan.agents.filter((x): x is PlanAgent & { new_auth_user_id: string } => x.action === 'relink')) {
    const row = plan.snapshot.agents.find((x) => x.id === a.id) as AgentRow
    const c = clerk.get(row.auth_subject!)
    if (!c?.email)
      throw new ApplyRefusal(
        `agent ${a.id}: its Clerk user has no primary address, so no Better Auth user can be made for it; plan again`,
      )
    out.push({ id: a.new_auth_user_id, name: a.name, email: c.email.toLowerCase(), verified: c.email_verified })
  }
  return out
}

/**
 * Inserts the `auth_users` rows (`ON CONFLICT DO NOTHING`, so a re-run inserts none), then reads them back: a plan id that is missing, or that holds another address, or an address held by another id
 * (a row of an earlier, discarded plan) is refused. The rows are inert until a CRM row links to them.
 */
export async function applyControlBatch(control: D1Like, plan: AuthPlan, now: Date): Promise<{ inserted: number }> {
  const rows = controlRows(plan)
  if (rows.length === 0) return { inserted: 0 }
  const at = now.toISOString()
  const results = await control.batch(
    rows.map((r) =>
      control
        .prepare(
          'insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict do nothing',
        )
        .bind(r.id, r.name, r.email, r.verified ? 1 : 0, at, at),
    ),
  )
  const inserted = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0)
  const back = await control.batch(
    rows.map((r) => control.prepare('select id, email from auth_users where id = ? or email = ?').bind(r.id, r.email)),
  )
  rows.forEach((r, i) => {
    const found = (back[i]?.results ?? []) as Array<{ id: string; email: string }>
    const other = found.find((f) => f.email === r.email && f.id !== r.id)
    if (other)
      throw new ApplyRefusal(
        `the address ${r.email} is already held by another auth user (${other.id}): a row left by an earlier plan. Apply the plan file that minted that row, or remove it, then plan again`,
      )
    const own = found.find((f) => f.id === r.id)
    if (!own) throw new ApplyRefusal(`auth user ${r.id} (${r.email}) is missing after the control batch`)
    if (own.email !== r.email)
      throw new ApplyRefusal(
        `auth user ${r.id} holds the address ${own.email}, not ${r.email}: a row left by another plan file. Apply the plan file that minted it, or plan again`,
      )
  })
  return { inserted }
}

// ---- the CRM batch (D1, D4, D13, P5, P6, P7) --------------------------------------------------------------

const AGENT_COLUMNS = Object.keys(agentRecord.shape)
const MEMBERSHIP_COLUMNS = Object.keys(membershipRecord.shape)
const agentKey = (id: string) => `agent:${id}`

/** `column = value`, or `column is null` for a null snapshot value: the drift guards compare against what the export saw. */
const same = (_qc: QueryContext, column: string, value: string | null) =>
  value === null ? sql<SqlBool>`${sql.ref(column)} is null` : sql<SqlBool>`${sql.ref(column)} = ${value}`

/**
 * The whole CRM change as ONE unit on the storage layer ([[OPS392]] P7): each update guarded by the snapshot's values, each event gated on its write and then asserted, so a row that changed since the export aborts the whole batch.
 * `users` re-points emit no event (identity bookkeeping, D13); membership and agent writes emit today's `membership.created` and `agent.updated` (P6), attributed to the system principal.
 */
function crmUnit(o: { plan: AuthPlan; organizationId: string; now: Date; newId: () => string }) {
  const { plan } = o
  const at = codecs.timestamp.write(o.now)
  const people = migrating(plan)
  const inserts = plan.people.filter(needsMembership)
  const touched = plan.agents.filter((a) => a.action === 'relink' || a.action === 'disable')
  const needsSystem = inserts.length + touched.length > 0
  const mint = needsSystem ? o.newId() : ''
  // every id is minted up front, so `build` is pure
  const membershipIds = inserts.map(() => ({ id: o.newId(), eventId: o.newId() }))
  const agentEventIds = touched.map(() => o.newId())
  const counts = countsOf(plan)
  const eventExists = (qc: QueryContext, id: string) =>
    assertStep(qc, sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${id})`)

  return defineOperation({
    name: 'auth_migrate.apply',
    mutates: people.length + touched.length + inserts.length > 0,
    reads: (qc) => {
      const reads: Record<string, Read> = {}
      if (needsSystem) reads[SYSTEM_PRINCIPAL_READ] = systemPrincipalRead(qc)
      for (const a of touched)
        reads[agentKey(a.id)] = readMaybe(
          qc.db
            .selectFrom('agents')
            .select(recordColumns(qc, 'agents', AGENT_COLUMNS))
            .where('agents.id', '=', a.id),
        )
      return reads
    },
    build: (found, qc) => {
      const steps: Step[] = []
      const events: EventReceipt[] = []
      let actor = ''
      if (needsSystem) {
        const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), mint, at)
        actor = sys.id
        steps.push(...sys.steps)
      }
      // users: re-pointed, guarded by the snapshot's provider and subject; no event
      for (const p of people) {
        const update = qc.db
          .updateTable('users')
          .set({ auth_provider: PROVIDER, auth_subject: p.new_auth_user_id!, updated_at: at })
          .where('users.id', '=', p.user_id)
          .where(same(qc, 'users.auth_provider', p.old_provider))
          .where(same(qc, 'users.auth_subject', p.old_subject))
        steps.push(...exactly(qc, step(update), 1))
      }
      // agents: re-pointed or disabled, guarded by the snapshot's links and not yet disabled; one agent.updated each
      touched.forEach((a, i) => {
        const row = found.maybe(agentKey(a.id))
        if (!row) throw new UnitDriftError('auth_migrate.apply')
        const snap = plan.snapshot.agents.find((x) => x.id === a.id)!
        const set =
          a.action === 'relink'
            ? { auth_provider: PROVIDER, auth_subject: a.new_auth_user_id!, updated_at: at }
            : { disabled_at: at, updated_at: at }
        const update = qc.db
          .updateTable('agents')
          .set(set)
          .where('agents.id', '=', a.id)
          .where(same(qc, 'agents.auth_provider', snap.auth_provider))
          .where(same(qc, 'agents.auth_subject', snap.auth_subject))
          .where(same(qc, 'agents.auth_client_id', snap.auth_client_id))
          .where('agents.disabled_at', 'is', null)
        const eventId = agentEventIds[i]!
        steps.push(
          step(update),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: o.organizationId,
              actorId: actor,
              type: 'agent.updated',
              resourceType: 'agent',
              resourceId: a.id,
              before: agentRecord.parse({ ...row, scopes: codecs.stringArray.readNullable(row.scopes) }),
              after: { table: 'agents', columns: AGENT_COLUMNS },
            }),
          ),
          eventExists(qc, eventId),
        )
        events.push({ id: eventId, type: 'agent.updated', resourceType: 'agent', resourceId: a.id })
      })
      // memberships: inserted when the person has no live one (the unique live index turns a racing row into a no-op, and the missing event then fails the assertion)
      inserts.forEach((p, i) => {
        const { id, eventId } = membershipIds[i]!
        const insert = qc.db
          .insertInto('memberships')
          .values({
            id,
            created_at: at,
            updated_at: at,
            organization_id: o.organizationId,
            user_id: p.user_id,
            role: p.role,
            created_by: actor,
          })
          .onConflict((oc) => oc.doNothing())
        steps.push(
          step(insert),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: o.organizationId,
              actorId: actor,
              type: 'membership.created',
              resourceType: 'membership',
              resourceId: id,
              before: null,
              after: { table: 'memberships', columns: MEMBERSHIP_COLUMNS },
            }),
          ),
          eventExists(qc, eventId),
        )
        events.push({ id: eventId, type: 'membership.created', resourceType: 'membership', resourceId: id })
      })
      return unit({
        steps,
        events,
        decode: () => ({
          users_repointed: counts.users,
          agents_relinked: counts.relinked,
          agents_disabled: counts.disabled,
          memberships_inserted: counts.memberships,
        }),
      })
    },
  })
}

// ---- the whole run ----------------------------------------------------------------------------------------

/**
 * Checks the state (refusing a mismatch before any write), writes the control batch, then the CRM batch. `applied`: nothing is written.
 * A refusal is an `ApplyRefusal` (exit 1); anything that fails once a write began is an `ApplyFailure` (exit 2), a drift naming itself so.
 */
export async function applyBatches(o: ApplyOptions): Promise<ApplyOutcome> {
  const state = assessState(o.plan, o.fresh)
  if (state === 'applied')
    return {
      state,
      control_inserted: 0,
      users_repointed: 0,
      agents_relinked: 0,
      agents_disabled: 0,
      memberships_inserted: 0,
    }

  const link = (await o.crm.prepare('select organization_id, auth_provider, auth_org_id from deployment').first()) as {
    organization_id: string
    auth_provider: string
    auth_org_id: string
  } | null
  if (!link) throw new ApplyRefusal('the CRM database has no deployment row: it is not an initialised instance')

  let control: { inserted: number }
  try {
    control = await applyControlBatch(o.control, o.plan, o.now())
  } catch (e) {
    if (e instanceof ApplyRefusal) throw e
    throw new ApplyFailure(`the control batch failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }

  const runtime = createD1Runtime(o.crm, {
    organizationId: link.organization_id,
    authProvider: link.auth_provider,
    authOrgId: link.auth_org_id,
  })
  try {
    const { value } = await runtime.execute(
      { kind: 'internal', organizationId: null },
      crmUnit({ plan: o.plan, organizationId: link.organization_id, now: o.now(), newId: o.newId }),
    )
    return { state, control_inserted: control.inserted, ...value }
  } catch (e) {
    if (e instanceof UnitDriftError)
      throw new ApplyFailure(
        'drift: a row changed between the export and the batch, so the CRM batch aborted and nothing in the CRM changed (the control rows stay, inert); plan again',
      )
    if (e instanceof CommitOutcomeUnknown)
      throw new ApplyFailure(
        `the CRM batch's outcome is unknown (${e.message}): re-run apply, which reads the state back`,
      )
    throw new ApplyFailure(
      `the CRM batch failed and nothing in the CRM changed: ${e instanceof StorageError || e instanceof Error ? e.message : 'unknown error'}`,
    )
  }
}
