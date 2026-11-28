// The acceptance program ([[CORE287]] P3, [[CORE259]] D9 (a)): the CRM half of accepting an invitation. ONE internal unit per role, attributed to the system principal, that writes the vault's rows for a
// Better Auth account: `owner`/`member` get a principal, a `users` row and a membership with `membership.created`; an `agent` invitation creates nothing: its account is linked to the agent the invitation names
// (`linkAgentAccount`, [[AGT702]]). It is the commit point of acceptance: the invitation is marked accepted only after it (the composition's job, `@vibase/storage-d1`'s `acceptInvitation`). Idempotent on the
// subject. `principals` and `users` stay the identity-bookkeeping exception of AGENTS.md invariant 5; the membership and agent rows emit their events in the same unit.
import { sql, type SqlBool } from 'kysely'
import {
  UnitDriftError,
  assertStep,
  codecs,
  defineOperation,
  execute,
  readMaybe,
  step,
  unit,
  type EventReceipt,
  type PreparedOperation,
  type QueryContext,
  type Read,
  type Step,
  type StorageBinding,
} from '@vibase/storage'
import { membershipRecord } from '../account/organizations.js'
import { SYSTEM_PRINCIPAL_READ, systemPrincipalRead, systemPrincipalSteps } from '../directory/system-principal.js'
import { ApiError, mapStorageError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import { agents } from '../resources/agents.js'
import { afterOf, receipt, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'
import type { InternalEnv } from '../storage/internal.js'

/** The provider every invited account belongs to: the built-in one ([[CORE243]] D9). */
export const BUILT_IN_PROVIDER = 'better-auth'

export type AcceptedAccount = { principalId: string }
type Account = {
  subject: string
  email: string
  name: string /** [[CORE294]] P5: the Better Auth user's `emailVerified`; absent (older callers) is false. */
  emailVerified?: boolean
}

const INTERNAL = { kind: 'internal', organizationId: null } as const
const MEMBERSHIP_COLUMNS = Object.keys(membershipRecord.shape)
const SUBJECT = 'accept:subject'
const EMAIL = 'accept:email'

/** The human half: principal, user, membership and `membership.created`, or nothing for a known subject. A held email belongs to another account: `409 account_conflict` (as first sight). */
export function acceptHumanOperation(
  a: Account & {
    role: 'owner' | 'member'
    organizationId: string
    principalId: string
    membershipId: string
    eventId: string
    systemId: string
    now: Date
  },
): PreparedOperation<AcceptedAccount> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<AcceptedAccount>({
    name: 'invitations.accept_human',
    mutates: true,
    reads: (qc: QueryContext) =>
      ({
        // ORDER MATTERS (as first sight): the email is read before the subject.
        [EMAIL]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.email', '=', a.email)),
        [SUBJECT]: readMaybe(
          qc.db
            .selectFrom('users')
            .select('users.id')
            .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
            .where('users.auth_subject', '=', a.subject),
        ),
        [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
      }) satisfies Record<string, Read>,
    build: (found, qc) => {
      const known = found.maybe(SUBJECT)
      if (known) return unit({ steps: [], events: [], decode: () => ({ principalId: known.id as string }) })
      if (found.maybe(EMAIL)) throw new ApiError(409, 'account_conflict', 'this email belongs to another account')
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.systemId, at)
      const user = qc.db
        .insertInto('users')
        .values({
          id: a.principalId,
          created_at: at,
          updated_at: at,
          email: a.email,
          name: a.name,
          auth_provider: BUILT_IN_PROVIDER,
          auth_subject: a.subject,
          email_verified: a.emailVerified === true,
        })
        .onConflict((oc) => oc.doNothing())
      const membership = qc.db
        .insertInto('memberships')
        .values({
          id: a.membershipId,
          created_at: at,
          updated_at: at,
          organization_id: a.organizationId,
          user_id: a.principalId,
          role: a.role,
          created_by: sys.id,
        })
        .onConflict((oc) => oc.doNothing())
      const holds = sql<SqlBool>`exists (select 1 from "users" where "users"."auth_provider" = ${BUILT_IN_PROVIDER} and "users"."auth_subject" = ${a.subject} and "users"."id" = ${a.principalId}) and exists (select 1 from "memberships" where "memberships"."id" = ${a.membershipId} and "memberships"."user_id" = ${a.principalId} and "memberships"."deleted_at" is null)`
      const result = qc.db.selectFrom('users').select('users.id').where('users.id', '=', a.principalId)
      const steps: Step[] = [
        ...sys.steps,
        step(qc.db.insertInto('principals').values({ id: a.principalId, kind: 'user', created_at: at })),
        step(user),
        step(membership),
        {
          ...step(
            eventStatement(qc, {
              id: a.eventId,
              at,
              organizationId: a.organizationId,
              actorId: sys.id,
              type: 'membership.created',
              resourceType: 'membership',
              resourceId: a.membershipId,
              before: null,
              after: { table: 'memberships', columns: MEMBERSHIP_COLUMNS },
            }),
          ),
          label: 'first-event',
        },
        assertStep(qc, holds),
        { ...step(result), label: 'result' },
      ]
      steps[0] = { ...steps[0]!, label: 'first-mutation' }
      const events: EventReceipt[] = [
        { id: a.eventId, type: 'membership.created', resourceType: 'membership', resourceId: a.membershipId },
      ]
      return unit({
        steps,
        events,
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('invitations.accept_human')
          return { principalId: rows[0]!.id as string }
        },
      })
    },
  })
}

/**
 * Writes the vault's rows for an invited account ([[CORE287]] P3): idempotent on the subject, so a repair or a race converges on one set of rows. A racing winner makes this unit drift; the answer is the
 * winner's principal (one read-only recheck, as first sight does).
 */
export async function acceptInvitedAccount(
  storage: StorageBinding,
  env: InternalEnv,
  a: Account & { role: 'owner' | 'member' },
): Promise<AcceptedAccount> {
  if (storage.kind !== 'd1') throw new Error('invitation acceptance serves a D1 deployment only')
  const op = acceptHumanOperation({
    ...a,
    role: a.role,
    organizationId: storage.organizationId,
    principalId: env.newId(),
    membershipId: env.newId(),
    eventId: env.newId(),
    systemId: env.newId(),
    now: env.now,
  })
  try {
    return (await execute(storage, INTERNAL, op)).value
  } catch (err) {
    if (!(err instanceof UnitDriftError)) throw mapStorageError(err)
  }
  // A racing acceptance of the same subject won: its rows are ours.
  const again = (await execute(storage, INTERNAL, lookupSubjectOperation(a.subject))).value
  if (!again) throw new ApiError(409, 'conflict', 'the record changed while the operation was running; retry')
  return again
}

const LINK_AGENT = 'link:agent'

/**
 * The link program ([[AGT702]] D16, [[AGT701]] D16): accepting an agent invitation links the new sign-in account to the agent the invitation names; it never creates an agent. ONE internal unit: a guarded `UPDATE agents`
 * setting `auth_provider` and `auth_subject` (and `updated_at`), matched on the id, the organisation and the agent being unlinked, not delegated and enabled, then one `agent.updated` by the system principal, gated on the
 * update having applied. Nothing else on the record changes (P2): the name and scopes are the owner's. A guard that matches nothing makes the unit drift (nothing written, no event). Internal to settling (P1): not an operation.
 */
export function linkAgentAccountOperation(a: {
  agentId: string
  subject: string
  organizationId: string
  eventId: string
  systemId: string
  now: Date
}): PreparedOperation<AcceptedAccount> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<AcceptedAccount>({
    name: 'agents.link_account',
    mutates: true,
    reads: (qc: QueryContext) =>
      ({
        // The record as the event's `before`, read without derived fields (as `updateOperation` does); an absent row has none.
        [LINK_AGENT]: readMaybe(
          selectRecord(agents, qc, { organizationId: a.organizationId } as PreparedEnv, a.agentId, { derived: false }),
        ),
        [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
      }) satisfies Record<string, Read>,
    build: (found, qc) => {
      const row = found.maybe(LINK_AGENT)
      if (!row)
        return unit({
          steps: [],
          events: [],
          decode: () => {
            throw new UnitDriftError('agents.link_account')
          },
        })
      const before = toRecord(agents, row as Record<string, unknown>)
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.systemId, at)
      const update = qc.db
        .updateTable('agents')
        .set({ auth_provider: BUILT_IN_PROVIDER, auth_subject: a.subject, updated_at: at })
        .where('agents.id', '=', a.agentId)
        .where('agents.organization_id', '=', a.organizationId)
        .where('agents.auth_provider', 'is', null)
        .where('agents.auth_client_id', 'is', null)
        .where('agents.disabled_at', 'is', null)
      const steps: Step[] = [
        ...sys.steps,
        step(update, undefined, { expect: 'affected' }),
        {
          ...step(
            eventStatement(qc, {
              id: a.eventId,
              at,
              organizationId: a.organizationId,
              actorId: sys.id,
              type: 'agent.updated',
              resourceType: 'agent',
              resourceId: a.agentId,
              before,
              after: afterOf(agents),
            }),
          ),
          label: 'first-event',
        },
        {
          ...step(
            qc.db
              .selectFrom('agents')
              .select('agents.id')
              .where('agents.id', '=', a.agentId)
              .where(sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${a.eventId})`),
          ),
          label: 'result',
        },
      ]
      steps[0] = { ...steps[0]!, label: 'first-mutation' }
      return unit({
        steps,
        events: [receipt(agents, a.eventId, 'updated', a.agentId)],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('agents.link_account')
          return { principalId: rows[0]!.id as string }
        },
      })
    },
  })
}

/**
 * Links the account to the agent ([[AGT702]] P3): on drift ONE read-only recheck; if the agent is now linked to THIS subject (a racing settle of the same sign-up won) its id is the answer, otherwise
 * `409 conflict` (the agent is unknown, disabled, delegated or linked to another subject), which settling lets through so no session is created and the invitation stays pending.
 */
export async function linkAgentAccount(
  storage: StorageBinding,
  env: InternalEnv,
  a: { agentId: string; subject: string },
): Promise<AcceptedAccount> {
  if (storage.kind !== 'd1') throw new Error('invitation acceptance serves a D1 deployment only')
  const op = linkAgentAccountOperation({
    ...a,
    organizationId: storage.organizationId,
    eventId: env.newId(),
    systemId: env.newId(),
    now: env.now,
  })
  try {
    return (await execute(storage, INTERNAL, op)).value
  } catch (err) {
    if (!(err instanceof UnitDriftError)) throw mapStorageError(err)
  }
  const again = await subjectStanding(storage, a.subject)
  if (again?.kind !== 'agent' || again.id !== a.agentId)
    throw new ApiError(
      409,
      'conflict',
      'the agent cannot be linked: it is unknown, disabled, delegated or already linked',
    )
  return { principalId: again.id }
}

function lookupSubjectOperation(subject: string): PreparedOperation<AcceptedAccount | null> {
  return defineOperation<AcceptedAccount | null>({
    name: 'invitations.accept_recheck',
    mutates: false,
    reads: (qc) => ({
      [SUBJECT]: readMaybe(
        qc.db
          .selectFrom('users')
          .select('users.id')
          .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
          .where('users.auth_subject', '=', subject),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => (found.maybe(SUBJECT) ? { principalId: found.maybe(SUBJECT)!.id as string } : null),
      }),
  })
}

/** What the vault holds for a Better Auth subject ([[CORE302]] P1, P4): a `users` row or an agent account, and for a human the creation time of its LIVE membership (ISO), if it has one. */
export type SubjectStanding = {
  kind: 'user' | 'agent'
  id: string
  liveMembershipCreatedAt:
    | string
    | null /** ISO instant of the latest removal (max `memberships.deleted_at`) of this user, or null ([[CORE302]] P1: a re-admitting invitation must be created strictly after it). */
  lastRemovedAt: string | null
}

/** The standing of the subject: a linked subject never re-runs the first-sight program ([[CORE287]] P5); it may complete P4, or (a human with no live membership) be re-admitted ([[CORE302]]). */
export function subjectStandingOperation(subject: string): PreparedOperation<SubjectStanding | null> {
  return defineOperation<SubjectStanding | null>({
    name: 'invitations.subject_standing',
    mutates: false,
    reads: (qc) => ({
      user: readMaybe(
        qc.db
          .selectFrom('users')
          .select('users.id')
          .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
          .where('users.auth_subject', '=', subject),
      ),
      agent: readMaybe(
        qc.db
          .selectFrom('agents')
          .select('agents.id')
          .where('agents.auth_provider', '=', BUILT_IN_PROVIDER)
          .where('agents.auth_subject', '=', subject),
      ),
      live: readMaybe(
        qc.db
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select('memberships.created_at')
          .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
          .where('users.auth_subject', '=', subject)
          .where('memberships.deleted_at', 'is', null),
      ),
      removed: readMaybe(
        qc.db
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select((eb) => eb.fn.max('memberships.deleted_at').as('last'))
          .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
          .where('users.auth_subject', '=', subject),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const user = found.maybe('user')
          if (user)
            return {
              kind: 'user' as const,
              id: user.id as string,
              liveMembershipCreatedAt: found.maybe('live')
                ? new Date(found.maybe('live')!.created_at as string).toISOString()
                : null,
              lastRemovedAt: found.maybe('removed')?.last
                ? new Date(found.maybe('removed')!.last as string).toISOString()
                : null,
            }
          const agent = found.maybe('agent')
          return agent
            ? { kind: 'agent' as const, id: agent.id as string, liveMembershipCreatedAt: null, lastRemovedAt: null }
            : null
        },
      }),
  })
}

export async function subjectStanding(storage: StorageBinding, subject: string): Promise<SubjectStanding | null> {
  try {
    return (await execute(storage, INTERNAL, subjectStandingOperation(subject))).value
  } catch (err) {
    throw mapStorageError(err)
  }
}

const LIVE_MEMBERSHIP = 'readmit:live'
const KNOWN_USER = 'readmit:user'

/**
 * Re-admits a removed member ([[CORE302]] P2): a NEW membership row with the invitation's role and `membership.created`, by the system principal; the removed row stays as history. `users` is not recreated;
 * `email_verified` becomes true when `verifyEmail` (an emailed invitation, never back to false). A live membership found at plan time makes the unit empty (a retry); one that appears between plan and commit
 * (a racing sign-in) makes the membership insert do nothing, and the assertion after the event then fails the whole unit (nothing is written, no second event).
 */
export function readmitHumanOperation(a: {
  subject: string
  role: 'owner' | 'member'
  verifyEmail: boolean
  organizationId: string
  membershipId: string
  eventId: string
  systemId: string
  now: Date
}): PreparedOperation<AcceptedAccount> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<AcceptedAccount>({
    name: 'invitations.readmit_human',
    mutates: true,
    reads: (qc: QueryContext) =>
      ({
        [KNOWN_USER]: readMaybe(
          qc.db
            .selectFrom('users')
            .select('users.id')
            .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
            .where('users.auth_subject', '=', a.subject),
        ),
        [LIVE_MEMBERSHIP]: readMaybe(
          qc.db
            .selectFrom('memberships')
            .innerJoin('users', 'users.id', 'memberships.user_id')
            .select('memberships.id')
            .where('users.auth_provider', '=', BUILT_IN_PROVIDER)
            .where('users.auth_subject', '=', a.subject)
            .where('memberships.deleted_at', 'is', null),
        ),
        [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
      }) satisfies Record<string, Read>,
    build: (found, qc) => {
      const user = found.maybe(KNOWN_USER)
      if (!user) throw new ApiError(409, 'conflict', 'the account has no vault user to re-admit')
      const userId = user.id as string
      if (found.maybe(LIVE_MEMBERSHIP)) return unit({ steps: [], events: [], decode: () => ({ principalId: userId }) })
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.systemId, at)
      const verify = qc.db
        .updateTable('users')
        .set({ email_verified: true, updated_at: at })
        .where('users.id', '=', userId)
        .where('users.email_verified', '=', false)
      const membership = qc.db
        .insertInto('memberships')
        .values({
          id: a.membershipId,
          created_at: at,
          updated_at: at,
          organization_id: a.organizationId,
          user_id: userId,
          role: a.role,
          created_by: sys.id,
        })
        .onConflict((oc) => oc.doNothing())
      const holds = sql<SqlBool>`exists (select 1 from "memberships" where "memberships"."id" = ${a.membershipId} and "memberships"."user_id" = ${userId} and "memberships"."deleted_at" is null)`
      const steps: Step[] = [
        ...sys.steps,
        ...(a.verifyEmail ? [step(verify)] : []),
        step(membership),
        {
          ...step(
            eventStatement(qc, {
              id: a.eventId,
              at,
              organizationId: a.organizationId,
              actorId: sys.id,
              type: 'membership.created',
              resourceType: 'membership',
              resourceId: a.membershipId,
              before: null,
              after: { table: 'memberships', columns: MEMBERSHIP_COLUMNS },
            }),
          ),
          label: 'first-event',
        },
        assertStep(qc, holds),
        { ...step(qc.db.selectFrom('users').select('users.id').where('users.id', '=', userId)), label: 'result' },
      ]
      steps[0] = { ...steps[0]!, label: 'first-mutation' }
      const events: EventReceipt[] = [
        { id: a.eventId, type: 'membership.created', resourceType: 'membership', resourceId: a.membershipId },
      ]
      return unit({
        steps,
        events,
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('invitations.readmit_human')
          return { principalId: rows[0]!.id as string }
        },
      })
    },
  })
}

/** Runs the re-admission; a racing sign-in that won makes this unit drift, and its live membership is ours (one read-only recheck, as `acceptInvitedAccount` does). */
export async function readmitMember(
  storage: StorageBinding,
  env: InternalEnv,
  a: { subject: string; role: 'owner' | 'member'; verifyEmail: boolean },
): Promise<AcceptedAccount> {
  if (storage.kind !== 'd1') throw new Error('invitation acceptance serves a D1 deployment only')
  const op = readmitHumanOperation({
    ...a,
    organizationId: storage.organizationId,
    membershipId: env.newId(),
    eventId: env.newId(),
    systemId: env.newId(),
    now: env.now,
  })
  try {
    return (await execute(storage, INTERNAL, op)).value
  } catch (err) {
    if (!(err instanceof UnitDriftError)) throw mapStorageError(err)
  }
  const again = await subjectStanding(storage, a.subject)
  if (again?.kind !== 'user' || again.liveMembershipCreatedAt === null)
    throw new ApiError(409, 'conflict', 'the record changed while the operation was running; retry')
  return { principalId: again.id }
}
