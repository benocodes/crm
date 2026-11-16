// The revert side of the hq auth migration ([[OPS394]], [[OPS250]] D8, P1-P6): the CRM unit that puts every link back as the plan's snapshot had it, and the three-way state check that decides what a run does.
// Nothing here touches the control database (P6) or the Worker: the CLI runs the unit first and the guarded deploy after (P1). One atomic unit on the storage layer, every statement guarded by the value apply left, attributed to the system principal.
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
import {
  AGENT_COLUMNS,
  ApplyFailure,
  ApplyRefusal,
  MEMBERSHIP_COLUMNS,
  PROVIDER as APPLIED_PROVIDER,
  agentKey,
  appliedDiffs,
  diffsAgainst,
  migrating,
  same,
} from './apply.js'
import type { AuthPlan, MembershipRow, Snapshot } from './types.js'

/** The marker's value before apply: a plan is made for a Clerk instance only ([[OPS365]] P2), so the snapshot's provider is `clerk`. */
export const ORIGINAL_PROVIDER = 'clerk'

export type RevertState = 'applied' | 'restored'
export interface RevertOutcome {
  users_restored: number
  agents_relinked_back: number
  agents_reenabled: number
  memberships_removed: number
}

const membershipKey = (id: string) => `membership:${id}`

/** What a revert would touch, from the plan and the memberships apply inserted. No personal data. */
export function describeRevert(plan: AuthPlan, inserted: readonly MembershipRow[]): RevertOutcome {
  return {
    users_restored: migrating(plan).length,
    agents_relinked_back: plan.agents.filter((a) => a.action === 'relink').length,
    agents_reenabled: plan.agents.filter((a) => a.action === 'disable').length,
    memberships_removed: inserted.length,
  }
}
export const revertLine = (c: RevertOutcome): string =>
  `CRM batch: users restored: ${c.users_restored}, agents relinked back: ${c.agents_relinked_back}, agents re-enabled: ${c.agents_reenabled}, memberships removed: ${c.memberships_removed}`

/** The live memberships the fresh export holds and the snapshot does not: the ones apply inserted (the state check has shown they are exactly those). */
export function insertedMemberships(plan: AuthPlan, fresh: Snapshot): MembershipRow[] {
  const known = new Set(plan.snapshot.memberships.map((m) => m.id))
  return fresh.memberships.filter((m) => !known.has(m.id) && m.deleted_at === null)
}

/**
 * A membership revert soft-deleted is a tombstone: a deleted row the snapshot does not hold. The export lists deleted rows too, so the comparison leaves them out, or a restored instance would never equal its snapshot (a soft delete is the only removal D8 and today's membership events know).
 * A deleted row a person added and removed since apply is left out the same way: it has no effect on any sign-in.
 */
function withoutTombstones(plan: AuthPlan, fresh: Snapshot): Snapshot {
  const known = new Set(plan.snapshot.memberships.map((m) => m.id))
  return { ...fresh, memberships: fresh.memberships.filter((m) => known.has(m.id) || m.deleted_at === null) }
}

/**
 * P5: which state the instance is in. `applied`: the fresh export is the snapshot with the plan applied and the marker reads better-auth. `restored`: it is the snapshot and the marker reads clerk. Anything else is a refusal naming the differing rows,
 * and the last resort of D8 (Time Travel to the plan's bookmarks, the operator's, never run by the tool). A plan that changes no row is told apart by the marker alone.
 */
export function assessRevert(plan: AuthPlan, freshExport: Snapshot, markerProvider: string): RevertState {
  const fresh = withoutTombstones(plan, freshExport)
  const fromSnapshot = diffsAgainst(plan.snapshot, fresh)
  const noRows =
    migrating(plan).length === 0 &&
    plan.agents.every((a) => a.action === 'keep') &&
    plan.people.every((p) => !(p.action === 'migrate' && p.role !== null && p.membership === null))
  const refuse = (named: string[]) => {
    throw new ApplyRefusal(
      `the instance is neither as the plan applied it nor as the plan found it: ${named.join('; ')}. Revert changes nothing. The last resort (OPS250 D8) is yours to run, never the tool's: restore the databases with Time Travel to the plan's bookmarks (CRM ${plan.crm.database_name} at ${plan.crm.bookmark}, control ${plan.control.database_name} at ${plan.control.bookmark}), which also undoes every write made since apply.`,
    )
  }
  const markerDiff = (want: string) => (markerProvider === want ? [] : [`deployment marker reads ${markerProvider}`])
  if (fromSnapshot.length === 0) {
    if (noRows && markerProvider === APPLIED_PROVIDER) return 'applied'
    const m = markerDiff(ORIGINAL_PROVIDER)
    return m.length === 0 ? 'restored' : refuse(m)
  }
  const fromApplied = appliedDiffs(plan, fresh)
  if (fromApplied.length === 0) {
    const m = markerDiff(APPLIED_PROVIDER)
    return m.length === 0 ? 'applied' : refuse(m)
  }
  return refuse(fromApplied.length < fromSnapshot.length ? fromApplied : fromSnapshot)
}

/** The CRM unit: ONE unit, each update guarded by the value apply left, each event gated on its write and then asserted. `users` and the marker emit no event (D13, D14). */
function revertUnit(o: {
  plan: AuthPlan
  inserted: readonly MembershipRow[]
  organizationId: string
  now: Date
  newId: () => string
}) {
  const { plan } = o
  const at = codecs.timestamp.write(o.now)
  const people = migrating(plan)
  const touched = plan.agents.filter((a) => a.action === 'relink' || a.action === 'disable')
  const needsSystem = o.inserted.length + touched.length > 0
  const mint = needsSystem ? o.newId() : ''
  const agentEventIds = touched.map(() => o.newId())
  const membershipEventIds = o.inserted.map(() => o.newId())
  const counts = describeRevert(plan, o.inserted)
  const eventExists = (qc: QueryContext, id: string) =>
    assertStep(qc, sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${id})`)

  return defineOperation({
    name: 'auth_migrate.revert',
    mutates: true, // the marker always changes
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
      for (const m of o.inserted)
        reads[membershipKey(m.id)] = readMaybe(
          qc.db
            .selectFrom('memberships')
            .select(recordColumns(qc, 'memberships', MEMBERSHIP_COLUMNS))
            .where('memberships.id', '=', m.id),
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
      // users: put back, guarded by the Better Auth link apply made; no event
      for (const p of people) {
        const update = qc.db
          .updateTable('users')
          .set({ auth_provider: p.old_provider, auth_subject: p.old_subject, updated_at: at })
          .where('users.id', '=', p.user_id)
          .where('users.auth_provider', '=', APPLIED_PROVIDER)
          .where('users.auth_subject', '=', p.new_auth_user_id!)
        steps.push(...exactly(qc, step(update), 1))
      }
      // agents: links put back or re-enabled, guarded by what apply left; one agent.updated each
      touched.forEach((a, i) => {
        const row = found.maybe(agentKey(a.id))
        if (!row) throw new UnitDriftError('auth_migrate.revert')
        const snap = plan.snapshot.agents.find((x) => x.id === a.id)!
        const base = qc.db.updateTable('agents').where('agents.id', '=', a.id)
        const update =
          a.action === 'relink'
            ? base
                .set({ auth_provider: snap.auth_provider, auth_subject: snap.auth_subject, updated_at: at })
                .where('agents.auth_provider', '=', APPLIED_PROVIDER)
                .where('agents.auth_subject', '=', a.new_auth_user_id!)
                .where(same(qc, 'agents.auth_client_id', snap.auth_client_id))
            : base
                .set({ disabled_at: null, updated_at: at })
                .where('agents.disabled_at', 'is not', null)
                .where(same(qc, 'agents.auth_provider', snap.auth_provider))
                .where(same(qc, 'agents.auth_subject', snap.auth_subject))
                .where(same(qc, 'agents.auth_client_id', snap.auth_client_id))
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
      // memberships apply inserted: soft-deleted, today's membership.deleted event (before = the row, no after), guarded by the row apply left
      o.inserted.forEach((m, i) => {
        const row = found.maybe(membershipKey(m.id))
        if (!row) throw new UnitDriftError('auth_migrate.revert')
        const update = qc.db
          .updateTable('memberships')
          .set({ deleted_at: at, updated_at: at })
          .where('memberships.id', '=', m.id)
          .where('memberships.user_id', '=', m.user_id)
          .where('memberships.role', '=', m.role as 'owner' | 'member')
          .where('memberships.deleted_at', 'is', null)
        const eventId = membershipEventIds[i]!
        steps.push(
          step(update),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: o.organizationId,
              actorId: actor,
              type: 'membership.deleted',
              resourceType: 'membership',
              resourceId: m.id,
              before: membershipRecord.parse(row),
              after: null,
            }),
          ),
          eventExists(qc, eventId),
        )
        events.push({ id: eventId, type: 'membership.deleted', resourceType: 'membership', resourceId: m.id })
      })
      // the marker goes back (D14 reversed), guarded by the value apply left; bootstrap bookkeeping, so no event
      steps.push(
        ...exactly(
          qc,
          step(
            sql`update deployment set auth_provider = ${ORIGINAL_PROVIDER} where singleton = 1 and auth_provider = ${APPLIED_PROVIDER}`.compile(
              qc.db,
            ),
          ),
          1,
        ),
      )
      return unit({ steps, events, decode: () => counts })
    },
  })
}

/**
 * Runs the CRM unit once the state is `applied` (the caller has checked it and read the instance's link). A drift aborts the whole unit (nothing changes); anything that fails here is an `ApplyFailure` (exit 2) a re-run reads back.
 */
export async function revertCrm(o: {
  plan: AuthPlan
  fresh: Snapshot
  crm: D1Like
  link: { organization_id: string; auth_provider: string; auth_org_id: string }
  now(): Date
  newId(): string
}): Promise<RevertOutcome> {
  const runtime = createD1Runtime(o.crm, {
    organizationId: o.link.organization_id,
    authProvider: o.link.auth_provider,
    authOrgId: o.link.auth_org_id,
  })
  try {
    const { value } = await runtime.execute(
      { kind: 'internal', organizationId: null },
      revertUnit({
        plan: o.plan,
        inserted: insertedMemberships(o.plan, o.fresh),
        organizationId: o.link.organization_id,
        now: o.now(),
        newId: o.newId,
      }),
    )
    return value
  } catch (e) {
    if (e instanceof UnitDriftError)
      throw new ApplyFailure(
        'drift: a row changed between the export and the batch, so the revert batch aborted and nothing in the CRM changed; run revert again, which reads the state afresh',
      )
    if (e instanceof CommitOutcomeUnknown)
      throw new ApplyFailure(
        `the revert batch's outcome is unknown (${e.message}): re-run revert, which reads the state back`,
      )
    throw new ApplyFailure(
      `the revert batch failed and nothing in the CRM changed: ${e instanceof StorageError || e instanceof Error ? e.message : 'unknown error'}`,
    )
  }
}

/** P6: the accounts of the plan's targets (migrated people, relinked agent accounts) that hold a credential row in the control database (a password or Google). Read-only; email only. */
export async function claimedAccounts(plan: AuthPlan, control: D1Like): Promise<string[]> {
  const subjects = [
    ...migrating(plan).map((p) => p.new_auth_user_id!),
    ...plan.agents.filter((a) => a.action === 'relink').map((a) => a.new_auth_user_id!),
  ]
  const out: string[] = []
  for (const id of subjects) {
    const account = await control.prepare('select 1 as n from auth_accounts where user_id = ? limit 1').bind(id).first()
    if (account === null) continue
    const user = (await control.prepare('select email from auth_users where id = ?').bind(id).first()) as {
      email: string
    } | null
    if (user) out.push(user.email)
  }
  return out
}
