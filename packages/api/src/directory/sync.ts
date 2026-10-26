import { sql, type SqlBool } from 'kysely'
import {
  SetLimitExceeded,
  UnitDriftError,
  appliedPrev,
  assertStep,
  bind,
  codecs,
  defineOperation,
  exactly,
  execute,
  jsonRows,
  memberOf,
  readMaybe,
  readSet,
  recordColumns,
  step,
  ts,
  unit,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Read,
  type Row,
  type Step,
  type StorageBinding,
} from '@vault/storage'
import { membershipRecord, organizationRecord } from '../account/organizations.js'
import { AuthFailure, type AuthAdapter } from '../auth/adapter.js'
import { lookupUser, provisionUser } from '../auth/first-sight.js'
import type { Role } from '../auth/roles.js'
import { ApiError, mapStorageError } from '../errors.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import { eventSetStatement, eventStatement } from '../outbox.js'
import type { InternalEnv } from '../storage/internal.js'
import { SYSTEM_PRINCIPAL_READ, systemPrincipalRead, systemPrincipalSteps } from './system-principal.js'

// The directory ([[CORE3]] D1, D18, D20, D21; [[CORE36]] D20; [[CORE41]] P8-P11): Clerk is the source of truth and the vault
// keeps a copy. Provider fetches happen first, outside any unit; each write is ONE internal unit, attributed to the system
// principal, whose plan reads are re-asserted at commit. Postgres serialises writers on a known organisation under the
// organisation writer lock; D1 relies on the guards.

export type ReconcileSummary = { organizationId: string | null; created: number; updated: number; deleted: number }
export type RefreshOutcome = 'updated' | 'unchanged' | 'unknown' | 'conflict' | 'unsupported'
export type RepairArgs = {
  provider: string
  externalId: string
  userId: string
  role: Role
  /** The vault organisation the sign-in already resolved, or null when it has never seen this provider organisation. */
  knownOrganizationId: string | null
  /** The provider's name for the organisation; set exactly when `knownOrganizationId` is null (the unit may have to create it). */
  fetchedName: string | null
  /** The id a new organisation gets: the binding's on D1 (one organisation per database), minted on Postgres. */
  newOrganizationId: string
  env: InternalEnv
}
export type ReconcileArgs = {
  provider: string
  externalId: string
  /** The provider's organisation, or null when the provider no longer has it. */
  organization: { name: string } | null
  members: ReadonlyArray<{ subject: string; role: Role }>
  newOrganizationId: string
  env: InternalEnv
}
export type RefreshArgs = { provider: string; subject: string; email: string; name: string | null; emailVerified: boolean; env: InternalEnv }

const INTERNAL_NULL = { kind: 'internal', organizationId: null } as const
const ORG_COLUMNS = Object.keys(organizationRecord.shape)
const MEMBERSHIP_COLUMNS = Object.keys(membershipRecord.shape)

const ORG = 'dir:org'
const LIVE = 'dir:live'
const USERS = 'dir:users'
const MEMBERSHIP = 'dir:membership'
const REFRESH_USER = 'refresh:user'
const REFRESH_EMAIL = 'refresh:email'

// ---- shared pieces --------------------------------------------------------------------------------------

function organizationRead(qc: QueryContext, provider: string, externalId: string) {
  return qc.db
    .selectFrom('organizations')
    .select([...recordColumns(qc, 'organizations', ORG_COLUMNS), ts.exact(qc, 'organizations.updated_at').as('__stamp')])
    .where('organizations.auth_provider', '=', provider)
    .where('organizations.auth_org_id', '=', externalId)
}

const orgRecord = (row: Row) => organizationRecord.parse({ id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at })
const memberRecord = (row: Row) =>
  membershipRecord.parse({
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    role: row.role,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

/** Labels the unit's first statement `first-mutation` and its first event `first-event` (the fault-injection points). */
function labelled(steps: Step[], firstEvent: number): Step[] {
  return steps.map((s, i) => (i === 0 ? { ...s, label: 'first-mutation' as const } : i === firstEvent ? { ...s, label: 'first-event' as const } : s))
}

const linkHolds = (provider: string, externalId: string, orgId: string) =>
  sql<SqlBool>`exists (select 1 from "organizations" where "organizations"."auth_provider" = ${provider} and "organizations"."auth_org_id" = ${externalId} and "organizations"."id" = ${orgId})`

/** The statements that create the organisation row, its event, then the assertion that the link is OURS. The event directly follows the insert. */
function createOrganization(
  qc: QueryContext,
  a: { provider: string; externalId: string; id: string; name: string; at: string; actorId: string; eventId: string },
): { steps: Step[]; eventAt: number } {
  const insert = qc.db
    .insertInto('organizations')
    .values({ id: a.id, created_at: a.at, updated_at: a.at, name: a.name, auth_provider: a.provider, auth_org_id: a.externalId })
    .onConflict((oc) => oc.doNothing())
  const event = eventStatement(qc, {
    id: a.eventId,
    at: a.at,
    organizationId: a.id,
    actorId: a.actorId,
    type: 'organization.created',
    resourceType: 'organization',
    resourceId: a.id,
    before: null,
    after: { table: 'organizations', columns: ORG_COLUMNS },
  })
  return { steps: [step(insert), step(event), assertStep(qc, linkHolds(a.provider, a.externalId, a.id))], eventAt: 1 }
}

// ---- repair ---------------------------------------------------------------------------------------------

/**
 * Makes the copy agree with a verified token claim for one user ([[CORE3]] D20): creates the organisation from the
 * provider if the vault has never seen it, then inserts or re-roles this user's live membership. Never deletes and
 * never renames. One internal unit: the organisation insert is ON CONFLICT DO NOTHING followed by an assertion that the
 * link points at the minted id, and the membership insert is followed by an assertion that the live membership is OURS,
 * so a racing loser drifts (and sign-in retries it once) instead of writing a second row.
 */
export function repairOperation(a: RepairArgs): PreparedOperation<string> {
  const at = codecs.timestamp.write(a.env.now)
  return defineOperation<string>({
    name: 'directory.repair',
    mutates: true,
    reads: (qc) => ({
      [ORG]: readMaybe(organizationRead(qc, a.provider, a.externalId)),
      [MEMBERSHIP]: readMaybe(
        qc.db
          .selectFrom('memberships')
          .innerJoin('organizations', 'organizations.id', 'memberships.organization_id')
          .select(recordColumns(qc, 'memberships', MEMBERSHIP_COLUMNS))
          .where('organizations.auth_provider', '=', a.provider)
          .where('organizations.auth_org_id', '=', a.externalId)
          .where('memberships.user_id', '=', a.userId)
          .where('memberships.deleted_at', 'is', null),
      ),
      [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
    }),
    build: (found, qc) => {
      const org = found.maybe(ORG)
      const live = found.maybe(MEMBERSHIP)
      if (!org && a.fetchedName === null) throw new Error('directory: a linked organisation disappeared during repair')
      const orgId = (org?.id as string | undefined) ?? a.newOrganizationId
      if (org && live && live.role === a.role) return unit({ steps: [], events: [], decode: () => orgId })

      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.env.newId(), at)
      const steps: Step[] = [...sys.steps]
      const events: EventReceipt[] = []
      let firstEvent = -1
      const note = (at_: number) => (firstEvent < 0 ? (firstEvent = steps.length + at_) : firstEvent)

      if (!org) {
        const eventId = a.env.newId()
        const made = createOrganization(qc, { provider: a.provider, externalId: a.externalId, id: orgId, name: a.fetchedName!, at, actorId: sys.id, eventId })
        note(made.eventAt)
        steps.push(...made.steps)
        events.push({ id: eventId, type: 'organization.created', resourceType: 'organization', resourceId: orgId })
      }
      if (!live) {
        const id = a.env.newId()
        const eventId = a.env.newId()
        const insert = qc.db
          .insertInto('memberships')
          .values({ id, created_at: at, updated_at: at, organization_id: orgId, user_id: a.userId, role: a.role, created_by: sys.id })
          .onConflict((oc) => oc.doNothing())
        note(1)
        steps.push(
          step(insert),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: orgId,
              actorId: sys.id,
              type: 'membership.created',
              resourceType: 'membership',
              resourceId: id,
              before: null,
              after: { table: 'memberships', columns: MEMBERSHIP_COLUMNS },
            }),
          ),
          assertStep(
            qc,
            sql<SqlBool>`exists (select 1 from "memberships" where "memberships"."id" = ${id} and "memberships"."organization_id" = ${orgId} and "memberships"."user_id" = ${a.userId} and "memberships"."deleted_at" is null)`,
          ),
        )
        events.push({ id: eventId, type: 'membership.created', resourceType: 'membership', resourceId: id })
      } else if (live.role !== a.role) {
        const eventId = a.env.newId()
        const update = qc.db
          .updateTable('memberships')
          .set({ role: a.role, updated_at: at })
          .where('memberships.id', '=', live.id as string)
          .where('memberships.organization_id', '=', orgId)
          .where('memberships.deleted_at', 'is', null)
          .where('memberships.role', '=', live.role as Role)
        note(1)
        steps.push(
          step(update, undefined, { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: orgId,
              actorId: sys.id,
              type: 'membership.updated',
              resourceType: 'membership',
              resourceId: live.id as string,
              before: memberRecord(live),
              after: { table: 'memberships', columns: MEMBERSHIP_COLUMNS },
            }),
          ),
        )
        events.push({ id: eventId, type: 'membership.updated', resourceType: 'membership', resourceId: live.id as string })
      }
      return unit({ steps: labelled(steps, firstEvent), events, decode: () => orgId })
    },
  })
}

// ---- reconcile ------------------------------------------------------------------------------------------

/**
 * The read-only first step of a reconcile: which vault organisation the provider id links to and which of the
 * snapshot's subjects the vault already knows (so only the unknown ones are provisioned).
 */
export function reconcilePlanOperation(a: { provider: string; externalId: string; subjects: readonly string[] }): PreparedOperation<{ organizationId: string | null; known: string[] }> {
  return defineOperation({
    name: 'directory.reconcile_plan',
    mutates: false,
    reads: (qc) => {
      const reads: Record<string, Read> = {
        [ORG]: readMaybe(qc.db.selectFrom('organizations').select('organizations.id').where('organizations.auth_provider', '=', a.provider).where('organizations.auth_org_id', '=', a.externalId)),
      }
      if (a.subjects.length > 0) {
        reads[USERS] = readSet(qc.db.selectFrom('users').select('users.auth_subject').where('users.auth_provider', '=', a.provider).where(memberOf(qc, 'users', 'auth_subject', a.subjects)))
      }
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => ({ organizationId: (found.maybe(ORG)?.id as string | undefined) ?? null, known: found.all(USERS).map((r) => r.auth_subject as string) }),
      }),
  })
}

/**
 * Applies a fetched snapshot of one provider organisation in ONE unit with a constant number of statements ([[CORE41]] P9):
 * the system principal (lazily), the organisation insert or rename with its event, then set statements over the PLANNED
 * ids, each with `exactly(n)`: the creates (one INSERT from a one-parameter set), the re-roles (at most one UPDATE per target
 * role) and the soft-deletes. One final assertion states that the organisation's live memberships are EXACTLY the snapshot's
 * (user, role) pairs, which closes an add, a removal and a swap that keeps the count between plan and commit. The events
 * (one set statement per kind) follow it; no statement gated on `changes()` follows an assertion. Every change stamps `now`.
 */
export function reconcileOperation(a: ReconcileArgs): PreparedOperation<ReconcileSummary> {
  const at = codecs.timestamp.write(a.env.now)
  const wanted = new Map(a.members.map((m) => [m.subject, m.role]))
  const subjects = [...wanted.keys()]
  return defineOperation<ReconcileSummary>({
    name: 'directory.reconcile',
    mutates: true,
    reads: (qc) => {
      const reads: Record<string, Read> = {
        [ORG]: readMaybe(organizationRead(qc, a.provider, a.externalId)),
        [LIVE]: readSet(
          qc.db
            .selectFrom('memberships')
            .innerJoin('organizations', 'organizations.id', 'memberships.organization_id')
            .innerJoin('users', 'users.id', 'memberships.user_id')
            .select([...recordColumns(qc, 'memberships', MEMBERSHIP_COLUMNS), 'users.auth_subject as subject'])
            .where('organizations.auth_provider', '=', a.provider)
            .where('organizations.auth_org_id', '=', a.externalId)
            .where('memberships.deleted_at', 'is', null)
            .orderBy('memberships.id'),
        ),
        [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
      }
      if (subjects.length > 0) {
        reads[USERS] = readSet(
          qc.db.selectFrom('users').select(['users.id', 'users.auth_subject']).where('users.auth_provider', '=', a.provider).where(memberOf(qc, 'users', 'auth_subject', subjects)),
        )
      }
      return reads
    },
    build: (found, qc) => {
      const org = found.maybe(ORG)
      const summary: ReconcileSummary = { organizationId: (org?.id as string | undefined) ?? null, created: 0, updated: 0, deleted: 0 }
      if (a.organization === null && !org) return unit({ steps: [], events: [], decode: () => summary })

      const idBySubject = new Map(found.all(USERS).map((u) => [u.auth_subject as string, u.id as string]))
      // A provider organisation that is gone wants no member at all; a member whose user was skipped (conflict, no email) is not wanted either.
      const desired =
        a.organization === null ? [] : [...wanted].flatMap(([subject, role]) => (idBySubject.has(subject) ? [{ subject, userId: idBySubject.get(subject)!, role }] : []))
      const live = found.all(LIVE)
      const liveBySubject = new Map(live.map((m) => [m.subject as string | null, m]))
      const keep = new Set(desired.map((d) => d.subject))
      const toDelete = live.filter((m) => m.subject === null || !keep.has(m.subject as string))
      const toCreate = desired.filter((d) => !liveBySubject.has(d.subject))
      const toRerole = desired.flatMap((d) => {
        const m = liveBySubject.get(d.subject)
        return m && m.role !== d.role ? [{ ...d, row: m }] : []
      })
      const rename = a.organization !== null && org !== null && org.name !== a.organization.name
      const create = a.organization !== null && org === null
      const changed = create || rename || toDelete.length + toCreate.length + toRerole.length > 0
      summary.created = toCreate.length
      summary.updated = toRerole.length
      summary.deleted = toDelete.length
      if (!changed) return unit({ steps: [], events: [], decode: () => summary })

      const orgId = (org?.id as string | undefined) ?? a.newOrganizationId
      summary.organizationId = orgId
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.env.newId(), at)
      const steps: Step[] = [...sys.steps]
      const events: EventReceipt[] = []
      let firstEvent = -1
      const note = (offset: number) => {
        if (firstEvent < 0) firstEvent = steps.length + offset
      }

      if (create) {
        const eventId = a.env.newId()
        const made = createOrganization(qc, { provider: a.provider, externalId: a.externalId, id: orgId, name: a.organization!.name, at, actorId: sys.id, eventId })
        note(made.eventAt)
        steps.push(...made.steps)
        events.push({ id: eventId, type: 'organization.created', resourceType: 'organization', resourceId: orgId })
      } else if (rename) {
        const eventId = a.env.newId()
        const update = qc.db
          .updateTable('organizations')
          .set({ name: a.organization!.name, updated_at: at })
          .where('organizations.id', '=', orgId)
          .where(sql<SqlBool>`${ts.exact(qc, 'organizations.updated_at')} = ${String(org!.__stamp)}`)
        note(1)
        steps.push(
          step(update, undefined, { expect: 'affected' }),
          step(
            eventStatement(qc, {
              id: eventId,
              at,
              organizationId: orgId,
              actorId: sys.id,
              type: 'organization.updated',
              resourceType: 'organization',
              resourceId: orgId,
              before: orgRecord(org!),
              after: { table: 'organizations', columns: ORG_COLUMNS },
            }),
          ),
        )
        events.push({ id: eventId, type: 'organization.updated', resourceType: 'organization', resourceId: orgId })
      }

      // creates: one INSERT from a one-parameter set
      const creates = toCreate.map((d) => ({ ...d, id: a.env.newId(), eventId: a.env.newId() }))
      if (creates.length > 0) {
        const set = jsonRows(qc, 'r', { id: 'uuid', user_id: 'uuid', role: 'text' }, creates.map((c) => ({ id: c.id, user_id: c.userId, role: c.role })))
        const insert = sql`insert into "memberships" ("id", "created_at", "updated_at", "organization_id", "user_id", "role", "created_by")
          select ${sql.ref('r.id')}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'timestamp', at)}, ${bind(qc, 'uuid', orgId)}, ${sql.ref('r.user_id')}, ${sql.ref('r.role')}, ${bind(qc, 'uuid', sys.id)}
          from ${set} order by ${sql.ref('r.ord')}`.compile(qc.db)
        steps.push(...exactly(qc, step(insert), creates.length))
      }
      // re-roles: at most one UPDATE per target role, over the planned ids
      for (const role of ['owner', 'member'] as const) {
        const rows = toRerole.filter((r) => r.role === role)
        if (rows.length === 0) continue
        const update = qc.db
          .updateTable('memberships')
          .set({ role, updated_at: at })
          .where('memberships.organization_id', '=', orgId)
          .where('memberships.deleted_at', 'is', null)
          .where('memberships.role', '<>', role)
          .where(memberOf(qc, 'memberships', 'id', rows.map((r) => r.row.id as string)))
        steps.push(...exactly(qc, step(update), rows.length))
      }
      // deletes: one UPDATE over the planned ids
      if (toDelete.length > 0) {
        const update = qc.db
          .updateTable('memberships')
          .set({ deleted_at: at, updated_at: at })
          .where('memberships.organization_id', '=', orgId)
          .where('memberships.deleted_at', 'is', null)
          .where(memberOf(qc, 'memberships', 'id', toDelete.map((m) => m.id as string)))
        steps.push(...exactly(qc, step(update), toDelete.length))
      }
      // the organisation's live memberships are exactly the snapshot's (user, role) pairs
      const pairs = desired.map((d) => ({ user_id: d.userId, role: d.role }))
      const wantA = jsonRows(qc, 'w1', { user_id: 'uuid', role: 'text' }, pairs)
      const wantB = jsonRows(qc, 'w2', { user_id: 'uuid', role: 'text' }, pairs)
      steps.push(
        assertStep(
          qc,
          sql<SqlBool>`not exists (select 1 from "memberships" where "memberships"."organization_id" = ${orgId} and "memberships"."deleted_at" is null
              and not exists (select 1 from ${wantA} where "w1"."user_id" = "memberships"."user_id" and "w1"."role" = "memberships"."role"))
            and not exists (select 1 from ${wantB} where not exists (select 1 from "memberships" where "memberships"."organization_id" = ${orgId} and "memberships"."deleted_at" is null
              and "memberships"."user_id" = "w2"."user_id" and "memberships"."role" = "w2"."role"))`,
        ),
      )
      // events, one set statement per kind (not gated on changes(): the exactly() above is what guarantees the set)
      const eventSet = (type: string, rows: Array<{ eventId: string; resourceId: string; before: Record<string, unknown> | null }>, after: boolean) => {
        if (rows.length === 0) return
        note(0)
        steps.push(
          step(
            eventSetStatement(qc, {
              at,
              organizationId: orgId,
              actorId: sys.id,
              type,
              resourceType: 'membership',
              after: after ? { table: 'memberships', columns: MEMBERSHIP_COLUMNS } : null,
              rows,
            }),
          ),
        )
        for (const r of rows) events.push({ id: r.eventId, type, resourceType: 'membership', resourceId: r.resourceId })
      }
      eventSet('membership.created', creates.map((c) => ({ eventId: c.eventId, resourceId: c.id, before: null })), true)
      eventSet('membership.updated', toRerole.map((r) => ({ eventId: a.env.newId(), resourceId: r.row.id as string, before: memberRecord(r.row) })), true)
      eventSet('membership.deleted', toDelete.map((m) => ({ eventId: a.env.newId(), resourceId: m.id as string, before: memberRecord(m) })), false)
      return unit({ steps: labelled(steps, firstEvent), events, decode: () => summary })
    },
  })
}

// ---- refresh --------------------------------------------------------------------------------------------

/**
 * Refreshes a known user's email, name and verification ([[CORE3]] D12: no event; [[CORE36]] D18): one guarded update
 * stamping `updated_at`. Never creates a user and never moves an email onto a second account (`'conflict'`).
 */
export function refreshUserOperation(a: RefreshArgs): PreparedOperation<RefreshOutcome> {
  const at = codecs.timestamp.write(a.env.now)
  return defineOperation<RefreshOutcome>({
    name: 'directory.refresh',
    mutates: true,
    reads: (qc) => ({
      [REFRESH_USER]: readMaybe(
        qc.db
          .selectFrom('users')
          .select(['users.id', 'users.email', 'users.name', 'users.email_verified', ts.exact(qc, 'users.updated_at').as('__stamp')])
          .where('users.auth_provider', '=', a.provider)
          .where('users.auth_subject', '=', a.subject),
      ),
      [REFRESH_EMAIL]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.email', '=', a.email)),
    }),
    build: (found, qc) => {
      const user = found.maybe(REFRESH_USER)
      const outcome = (o: RefreshOutcome) => unit({ steps: [], events: [], decode: () => o })
      if (!user) return outcome('unknown')
      const holder = found.maybe(REFRESH_EMAIL)
      if (holder && holder.id !== user.id) {
        console.warn('[directory] user refresh: email belongs to another account', { provider: a.provider })
        return outcome('conflict')
      }
      if (user.email === a.email && user.name === a.name && codecs.boolean.read(user.email_verified) === a.emailVerified) return outcome('unchanged')
      const update = qc.db
        .updateTable('users')
        .set({ email: a.email, name: a.name, email_verified: a.emailVerified, updated_at: at })
        .where('users.id', '=', user.id as string)
        .where(sql<SqlBool>`${ts.exact(qc, 'users.updated_at')} = ${String(user.__stamp)}`)
      const applied = qc.db.selectNoFrom(sql<number>`1`.as('applied')).where(appliedPrev(qc))
      return unit({
        steps: [step(update, 'first-mutation', { expect: 'affected' }), step(applied, 'result')],
        events: [],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('directory.refresh')
          return 'updated'
        },
      })
    },
  })
}

// ---- the async wrappers ---------------------------------------------------------------------------------

const forbidden = () => new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
/** A D1 serves one provider organisation (D19): a unit for another link is refused before any SQL. */
const foreignLink = (storage: StorageBinding, provider: string, externalId: string) =>
  storage.kind === 'd1' && (provider !== storage.authProvider || externalId !== storage.authOrgId)
const newOrganizationId = (storage: StorageBinding, env: InternalEnv) => (storage.kind === 'd1' ? storage.organizationId : env.newId())

/**
 * Repair for a verified claim. The provider is asked about an organisation the vault has never seen BEFORE the unit
 * (an organisation the provider no longer has is `403 organization_forbidden`). It runs inside sign-in, so a drift
 * (a racing repair created the organisation or the membership) is retried ONCE with a fresh plan, and the retry finds the
 * winner's rows; a second drift is `409 conflict`.
 */
export async function repairMembership(
  storage: StorageBinding,
  adapter: AuthAdapter,
  a: { userId: string; externalId: string; role: Role; known: { organizationId: string | null } },
  env: InternalEnv,
): Promise<string> {
  if (foreignLink(storage, adapter.provider, a.externalId)) throw forbidden()
  let fetchedName: string | null = null
  if (a.known.organizationId === null) {
    const fetched = await adapter.fetchOrganization(a.externalId)
    // The token is at most a minute stale; a copy of a deleted organisation is worse than a refusal (P6).
    if (fetched === null) throw forbidden()
    fetchedName = fetched.name
  }
  const run = () =>
    execute(
      storage,
      { kind: 'internal', organizationId: a.known.organizationId },
      repairOperation({
        provider: adapter.provider,
        externalId: a.externalId,
        userId: a.userId,
        role: a.role,
        knownOrganizationId: a.known.organizationId,
        fetchedName,
        newOrganizationId: newOrganizationId(storage, env),
        env,
      }),
    )
  try {
    return (await run()).value
  } catch (err) {
    if (!(err instanceof UnitDriftError)) throw mapStorageError(err)
  }
  try {
    return (await run()).value
  } catch (err) {
    throw mapStorageError(err)
  }
}

/**
 * Reads one provider organisation and brings the copy to match ([[CORE3]] "Directory sync"): organisation row (created or
 * renamed), then every membership inserted, re-roled or soft-deleted. Idempotent: a second run with nothing changed writes
 * nothing and emits nothing. Order: the whole snapshot is fetched first (a failure writes nothing), a snapshot larger than
 * the runtime's cap is refused before anything is written, members the vault has never seen are provisioned, then ONE unit.
 * No retry: drift is `409 conflict` and the provider redelivers.
 */
export async function reconcileOrganization(storage: StorageBinding, adapter: AuthAdapter, externalId: string, env: InternalEnv): Promise<ReconcileSummary> {
  const provider = adapter.provider
  if (foreignLink(storage, provider, externalId)) throw forbidden()
  // 1. Network first.
  const organization = await adapter.fetchOrganization(externalId)
  const members = organization ? await adapter.listMembers(externalId) : []
  // 2. The cap, before any write or any profile fetch.
  const limit = storage.runtime.maxSetSize
  if (members.length > limit) {
    console.warn('[directory] snapshot over the set limit', { members: members.length, limit })
    throw mapStorageError(new SetLimitExceeded(limit, members.length))
  }
  try {
    // 3. Which organisation and which subjects the vault knows (read-only).
    const subjects = [...new Set(members.map((m) => m.subject))]
    const plan = (await execute(storage, INTERNAL_NULL, reconcilePlanOperation({ provider, externalId, subjects }))).value
    // 4. Provision the unknown members, one unit each. A conflict skips that member (the catch is out here: the unit already rolled back).
    const known = new Set(plan.known)
    for (const subject of subjects) {
      if (known.has(subject)) continue
      try {
        await provisionUser(storage, adapter, subject, env)
      } catch (err) {
        if (err instanceof AuthFailure) console.warn('[directory] member skipped', { reason: 'no_email' })
        else if (err instanceof ApiError && err.code === 'account_conflict') console.warn('[directory] member skipped', { reason: 'account_conflict' })
        else if (err instanceof ApiError && err.code === 'invalid_identity') console.warn('[directory] member skipped', { reason: 'invalid_identity' })
        else throw err
      }
    }
    // 5. The snapshot, in one unit under the organisation's writer lock (Postgres) when the organisation exists.
    return (
      await execute(
        storage,
        { kind: 'internal', organizationId: plan.organizationId },
        reconcileOperation({ provider, externalId, organization: organization ? { name: organization.name } : null, members, newOrganizationId: newOrganizationId(storage, env), env }),
      )
    ).value
  } catch (err) {
    throw mapStorageError(err)
  }
}

/**
 * Refreshes a known user from the provider ([[CORE3]] D12). An unknown subject costs no provider call. A provider email the
 * vault cannot store (non-ASCII or malformed, D7) is `'unsupported'`: logged, nothing written.
 */
export async function refreshUser(storage: StorageBinding, adapter: AuthAdapter, subject: string, env: InternalEnv): Promise<RefreshOutcome> {
  const provider = adapter.provider
  if (!(await lookupUser(storage, { provider, subject, organizationExternalId: null }))) return 'unknown'
  const profile = await adapter.fetchProfile(subject)
  const raw = profile.email?.trim()
  if (!raw) {
    console.warn('[directory] user refresh: provider returned no email', { provider })
    return 'unchanged'
  }
  let email: string
  try {
    email = normalizeIdentityValue('email', raw)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'invalid_identity') {
      console.warn('[directory] user refresh: unsupported email address', { provider })
      return 'unsupported'
    }
    throw err
  }
  try {
    return (await execute(storage, INTERNAL_NULL, refreshUserOperation({ provider, subject, email, name: profile.name, emailVerified: profile.emailVerified, env }))).value
  } catch (err) {
    throw mapStorageError(err)
  }
}
