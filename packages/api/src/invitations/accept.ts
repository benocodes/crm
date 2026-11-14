// The acceptance program ([[CORE287]] P3, [[CORE259]] D9 (a)): the CRM half of accepting an invitation. ONE internal unit per role, attributed to the system principal, that writes the vault's rows for a
// Better Auth account: `owner`/`member` get a principal, a `users` row and a membership with `membership.created`; `agent` gets an agent principal and a linked `agents` row with scopes `[]` and
// `agent.created`. It is the commit point of acceptance: the invitation is marked accepted only after it (the composition's job, `@vibase/storage-d1`'s `acceptInvitation`). Idempotent on the
// subject. `principals` and `users` stay the identity-bookkeeping exception of AGENTS.md invariant 5; the membership and agent rows emit their events in the same unit.
import { sql, type SqlBool } from 'kysely'
import { UnitDriftError, assertStep, codecs, defineOperation, execute, readMaybe, step, unit, type EventReceipt, type PreparedOperation, type QueryContext, type Read, type Step, type StorageBinding } from '@vibase/storage'
import { membershipRecord } from '../account/organizations.js'
import { provisionAgent } from '../auth/agent-principals.js'
import { SYSTEM_PRINCIPAL_READ, systemPrincipalRead, systemPrincipalSteps } from '../directory/system-principal.js'
import { ApiError, mapStorageError } from '../errors.js'
import { eventStatement } from '../outbox.js'
import type { InternalEnv } from '../storage/internal.js'
import type { InvitationRole } from './port.js'

/** The provider every invited account belongs to: the built-in one ([[CORE243]] D9). */
export const BUILT_IN_PROVIDER = 'better-auth'

export type AcceptedAccount = { principalId: string }
type Account = { subject: string; email: string; name: string }

const INTERNAL = { kind: 'internal', organizationId: null } as const
const MEMBERSHIP_COLUMNS = Object.keys(membershipRecord.shape)
const SUBJECT = 'accept:subject'
const EMAIL = 'accept:email'

/** The human half: principal, user, membership and `membership.created`, or nothing for a known subject. A held email belongs to another account: `409 account_conflict` (as first sight). */
export function acceptHumanOperation(a: Account & { role: 'owner' | 'member'; organizationId: string; principalId: string; membershipId: string; eventId: string; systemId: string; now: Date }): PreparedOperation<AcceptedAccount> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<AcceptedAccount>({
    name: 'invitations.accept_human',
    mutates: true,
    reads: (qc: QueryContext) => ({
      // ORDER MATTERS (as first sight): the email is read before the subject.
      [EMAIL]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.email', '=', a.email)),
      [SUBJECT]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', BUILT_IN_PROVIDER).where('users.auth_subject', '=', a.subject)),
      [SYSTEM_PRINCIPAL_READ]: systemPrincipalRead(qc),
    } satisfies Record<string, Read>),
    build: (found, qc) => {
      const known = found.maybe(SUBJECT)
      if (known) return unit({ steps: [], events: [], decode: () => ({ principalId: known.id as string }) })
      if (found.maybe(EMAIL)) throw new ApiError(409, 'account_conflict', 'this email belongs to another account')
      const sys = systemPrincipalSteps(qc, found.maybe(SYSTEM_PRINCIPAL_READ), a.systemId, at)
      const user = qc.db
        .insertInto('users')
        .values({ id: a.principalId, created_at: at, updated_at: at, email: a.email, name: a.name, auth_provider: BUILT_IN_PROVIDER, auth_subject: a.subject, email_verified: false })
        .onConflict((oc) => oc.doNothing())
      const membership = qc.db
        .insertInto('memberships')
        .values({ id: a.membershipId, created_at: at, updated_at: at, organization_id: a.organizationId, user_id: a.principalId, role: a.role, created_by: sys.id })
        .onConflict((oc) => oc.doNothing())
      const holds = sql<SqlBool>`exists (select 1 from "users" where "users"."auth_provider" = ${BUILT_IN_PROVIDER} and "users"."auth_subject" = ${a.subject} and "users"."id" = ${a.principalId}) and exists (select 1 from "memberships" where "memberships"."id" = ${a.membershipId} and "memberships"."user_id" = ${a.principalId} and "memberships"."deleted_at" is null)`
      const result = qc.db.selectFrom('users').select('users.id').where('users.id', '=', a.principalId)
      const steps: Step[] = [
        ...sys.steps,
        step(qc.db.insertInto('principals').values({ id: a.principalId, kind: 'user', created_at: at })),
        step(user),
        step(membership),
        { ...step(eventStatement(qc, { id: a.eventId, at, organizationId: a.organizationId, actorId: sys.id, type: 'membership.created', resourceType: 'membership', resourceId: a.membershipId, before: null, after: { table: 'memberships', columns: MEMBERSHIP_COLUMNS } })), label: 'first-event' },
        assertStep(qc, holds),
        { ...step(result), label: 'result' },
      ]
      steps[0] = { ...steps[0]!, label: 'first-mutation' }
      const events: EventReceipt[] = [{ id: a.eventId, type: 'membership.created', resourceType: 'membership', resourceId: a.membershipId }]
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
export async function acceptInvitedAccount(storage: StorageBinding, env: InternalEnv, a: Account & { role: InvitationRole }): Promise<AcceptedAccount> {
  if (storage.kind !== 'd1') throw new Error('invitation acceptance serves a D1 deployment only')
  if (a.role === 'agent') {
    // Scopes `[]`: an invitation carries none; the owner grants them with `agents.update` ([[CORE287]] P3).
    const agent = await provisionAgent(storage, env, { provider: BUILT_IN_PROVIDER, subject: a.subject, clientId: null, kind: 'account', name: a.name, scopes: [], humanId: null, organizationId: storage.organizationId })
    return { principalId: agent.agentId }
  }
  const op = acceptHumanOperation({ ...a, role: a.role, organizationId: storage.organizationId, principalId: env.newId(), membershipId: env.newId(), eventId: env.newId(), systemId: env.newId(), now: env.now })
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

function lookupSubjectOperation(subject: string): PreparedOperation<AcceptedAccount | null> {
  return defineOperation<AcceptedAccount | null>({
    name: 'invitations.accept_recheck',
    mutates: false,
    reads: (qc) => ({ [SUBJECT]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', BUILT_IN_PROVIDER).where('users.auth_subject', '=', subject)) }),
    build: (found) => unit({ steps: [], events: [], decode: () => (found.maybe(SUBJECT) ? { principalId: found.maybe(SUBJECT)!.id as string } : null) }),
  })
}

/** The principal the vault already holds for this subject (a `users` row or an agent account). A linked subject never re-runs the CRM program ([[CORE287]] P5); it may only complete P4. */
export function linkedSubjectOperation(subject: string): PreparedOperation<string | null> {
  return defineOperation<string | null>({
    name: 'invitations.linked_subject',
    mutates: false,
    reads: (qc) => ({
      user: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', BUILT_IN_PROVIDER).where('users.auth_subject', '=', subject)),
      agent: readMaybe(qc.db.selectFrom('agents').select('agents.id').where('agents.auth_provider', '=', BUILT_IN_PROVIDER).where('agents.auth_subject', '=', subject)),
    }),
    build: (found) => unit({ steps: [], events: [], decode: () => ((found.maybe('user') ?? found.maybe('agent'))?.id as string | undefined) ?? null }),
  })
}

/** The principal id of the `users` row or agent account linked to the subject, or `null`. */
export async function linkedPrincipalId(storage: StorageBinding, subject: string): Promise<string | null> {
  try {
    return (await execute(storage, INTERNAL, linkedSubjectOperation(subject))).value
  } catch (err) {
    throw mapStorageError(err)
  }
}
