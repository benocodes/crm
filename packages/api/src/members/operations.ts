import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import { z } from 'zod'
import { defineOperation, readAll, readMaybe, unit, type PreparedOperation, type QueryContext, type StorageDatabase } from '@vibase/storage'
import { membershipRecord, type MembershipRecord } from '../account/organizations.js'
import { ApiError } from '../errors.js'
import { passwordResetUrl } from '../invitations/token.js'
import type { TenantOperation } from '../registry.js'
import { parseInput } from '../resources/define.js'
import type { PreparedEnv, PreparedResource } from '../storage/definition.js'
import { canonicalId } from '../storage/prepare.js'
import { deleteOperation, toRecord, updateOperation } from '../storage/crud.js'
import type { MembersRuntime } from './port.js'

/** The built-in provider: only its users have a Better Auth account to revoke or reset ([[CORE243]] D9). */
const BUILT_IN = 'better-auth'
const NO_STORE = 'membership administration needs the built-in auth provider (AUTH_PROVIDER=better-auth); this deployment keeps its members in its identity provider'

export const membershipUpdateBody = z.strictObject({ role: z.enum(['owner', 'member']) })

/**
 * [[CORE288]] P4: refuses, in the write's own statement, to leave the organisation with no live owner. True for the target row when it is not an owner, or another live owner exists at commit; the
 * plan-time read in `lastOwnerCheck` only chooses the answer (409), this predicate is what makes two owners removing each other leave one.
 */
const notLastOwner = (env: PreparedEnv): Expression<SqlBool> =>
  sql<SqlBool>`not ("memberships"."role" = 'owner' and not exists (select 1 from "memberships" "o" where "o"."organization_id" = ${env.organizationId} and "o"."role" = 'owner' and "o"."deleted_at" is null and "o"."id" <> "memberships"."id"))`

type Membership = PreparedResource<'memberships', MembershipRecord>

/** The membership definition with the last-owner predicate ANDed into its update and delete. `demoting` false: the write cannot lower an owner (a promotion or a no-op role). */
const guarded = (def: Membership, demoting: boolean): Membership => ({
  ...def,
  guards: (_eb: ExpressionBuilder<StorageDatabase, 'memberships'>, env: PreparedEnv) => (demoting ? [notLastOwner(env)] : []),
})

/** Plan-time half of P4: a demotion or removal of the only live owner is `409 last_owner`, decided from one read in the same plan as the target row. */
function lastOwnerCheck<T>(inner: PreparedOperation<T>, env: PreparedEnv, id: string, demoting: boolean): PreparedOperation<T> {
  return defineOperation<T>({
    name: inner.name,
    mutates: inner.mutates,
    reads: (qc) => ({
      ...inner.reads(qc),
      others: readAll(qc.db.selectFrom('memberships').select('memberships.id').where('memberships.organization_id', '=', env.organizationId).where('memberships.role', '=', 'owner').where('memberships.deleted_at', 'is', null).where('memberships.id', '<>', id).limit(1)),
    }),
    build: (found, qc) => {
      const row = found.maybe('before')
      if (demoting && row && row.role === 'owner' && found.all('others').length === 0) throw new ApiError(409, 'last_owner', 'the workspace needs at least one owner: make another member an owner first')
      return inner.build(found, qc)
    },
  })
}

/** `memberships.update` ([[CORE288]] P1, P3, P4): a role change. A role equal to the current one is a real update, as every generic update is (`updated_at` moves, the event is written). */
export function updateMembershipOperation(def: Membership, env: PreparedEnv, rawId: string, body: unknown): PreparedOperation<MembershipRecord> {
  const { role } = parseInput(membershipUpdateBody, body) as z.infer<typeof membershipUpdateBody>
  const id = canonicalId(def, rawId)
  return lastOwnerCheck(updateOperation(guarded(def, role === 'member'), env, id, { role }), env, id, role === 'member')
}

/** `memberships.delete` ([[CORE288]] P1, P3, P4): the soft delete of the generic core, answering with the record it removed (the `membership.deleted` event's `before`). */
export function deleteMembershipOperation(def: Membership, env: PreparedEnv, rawId: string): PreparedOperation<MembershipRecord> {
  const id = canonicalId(def, rawId)
  const inner = deleteOperation(guarded(def, true), env, id)
  const checked = lastOwnerCheck(inner, env, id, true)
  return defineOperation<MembershipRecord>({
    name: inner.name,
    mutates: true,
    reads: checked.reads,
    build: (found, qc) => {
      const row = found.maybe('before')
      const unitOf = checked.build(found, qc)
      const { __stamp: _stamp, ...rest } = (row ?? {}) as Record<string, unknown>
      const record = toRecord(def, rest as never)
      return unit({ ...unitOf, decode: (rows, f) => (unitOf.decode(rows, f), record) })
    },
  })
}

/** What a removal's unit hands its after-commit stage: the removed record, the Better Auth subject to revoke (when the member belongs to the built-in provider) and the values the control batch needs. */
interface Removal {
  record: MembershipRecord
  subject: string | null
  actorId: string
  auditId: string
  now: string
}

const needsStore = (runtime: MembersRuntime | null): MembersRuntime => {
  if (!runtime) throw new ApiError(501, 'provider_not_configured', NO_STORE)
  return runtime
}

/** The removed member's Better Auth subject, read in the removal's own plan (the `users` row stays after the removal; the membership row is the join). */
function withSubject(inner: PreparedOperation<MembershipRecord>, env: PreparedEnv, id: string): PreparedOperation<Removal> {
  return defineOperation<Removal>({
    name: inner.name,
    mutates: inner.mutates,
    reads: (qc: QueryContext) => ({
      ...inner.reads(qc),
      member: readMaybe(qc.db.selectFrom('memberships').innerJoin('users', 'users.id', 'memberships.user_id').select(['users.auth_provider as provider', 'users.auth_subject as subject']).where('memberships.id', '=', id)),
    }),
    build: (found, qc) => {
      const unitOf = inner.build(found, qc)
      const member = found.maybe('member')
      const subject = member && member.provider === BUILT_IN && typeof member.subject === 'string' ? member.subject : null
      return unit({ ...unitOf, decode: (rows, f) => ({ record: unitOf.decode(rows, f), subject, actorId: env.actor.id, auditId: env.newId(), now: env.now.toISOString() }) })
    },
  })
}

/**
 * The hand-written stages of the generated `memberships.update` and `memberships.delete` ([[CORE288]]): the composition's control store (501 without one), a drifted unit re-planned once so a lost
 * race on the last owner answers 409, and for the removal the after-commit revocation ([[CORE259]] D9 (b)): the CRM unit is the commit point, then ONE best-effort control batch. A control failure is
 * logged by name and the answer is still 200: the removal happened and denial is already immediate (the role is read per request), the sweep ([[CORE289]]) finishes it.
 */
export function withMembershipWrites(def: Membership, runtime: MembersRuntime | null): { update: (op: TenantOperation) => TenantOperation; delete: (op: TenantOperation) => TenantOperation } {
  return {
    update: (op) => ({ ...op, replanOnDrift: true, prepare: (env, input, ctx) => (needsStore(runtime), op.prepare(env, input, ctx)) }),
    delete: (op) => ({
      ...op,
      replanOnDrift: true,
      response: { status: 200, schema: membershipRecord },
      prepare: async (env, input) => {
        needsStore(runtime)
        return withSubject(deleteMembershipOperation(def, env, input.params.id as string), env, canonicalId(def, input.params.id as string))
      },
      after: async (value) => {
        const done = value as Removal
        if (done.subject !== null) {
          try {
            await runtime!.port.revokeCredentials({ subject: done.subject, auditId: done.auditId, actorId: done.actorId, now: done.now })
          } catch (err) {
            console.error(`[members] credential revocation after a removal failed: ${err instanceof Error ? err.name : 'error'}`)
          }
        }
        return done.record
      },
    }),
  }
}

const issueBody = z.strictObject({ user_id: z.uuid() })
const issued = z.object({ url: z.string().describe('The one-time reset link; shown once'), expires_at: z.iso.datetime({ offset: true }) })

/** The user a reset link may be issued for: a live member of this organisation whose account the built-in provider holds (Clerk-era users and agents are not). */
function resetTargetOperation(env: PreparedEnv, userId: string): PreparedOperation<{ email: string; subject: string; actorId: string; auditId: string; now: string }> {
  return defineOperation({
    name: 'users.issue_reset_link',
    mutates: false,
    reads: (qc) => ({
      target: readMaybe(
        qc.db
          .selectFrom('users')
          .innerJoin('memberships', 'memberships.user_id', 'users.id')
          .select(['users.email as email', 'users.auth_subject as subject'])
          .where('users.id', '=', userId)
          .where('users.auth_provider', '=', BUILT_IN)
          .where('memberships.organization_id', '=', env.organizationId)
          .where('memberships.deleted_at', 'is', null),
      ),
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const t = found.maybe('target')
          if (!t || typeof t.subject !== 'string') throw new ApiError(404, 'not_found', 'user not found')
          return { email: t.email as string, subject: t.subject, actorId: env.actor.id, auditId: env.newId(), now: env.now.toISOString() }
        },
      }),
  })
}

/**
 * `users.issue_reset_link` ([[CORE288]] P6): a one-time password-reset link for a member, for owners. A read-only unit chooses the target (404 for anything but a live built-in member), then the after-commit
 * stage drives Better Auth's reset request in-process, writes the audit row and answers `{url, expires_at}` once. The token is never stored, logged or put in the audit detail.
 */
export function resetLinkOperation(runtime: MembersRuntime | null): TenantOperation {
  return {
    kind: 'tenant',
    surface: 'meta',
    name: 'users.issue_reset_link',
    summary: 'Issue a one-time password reset link for a member; the link is shown once',
    description:
      'Human only (owners). For a member of this workspace who signs in with a password on the built-in auth provider (not an agent, not a removed member): returns a link that lets them set a new password, valid for one hour and shown once. Give it to the member yourself; there is no email. Ends all of that member\'s sessions when they use it. Answers 404 for anyone else and 501 provider_not_configured when the deployment has no built-in auth provider.',
    tags: ['users'],
    method: 'post',
    path: '/users/reset-link',
    scope: { resource: 'members', action: 'write' },
    proposal: { eligible: false, reason: 'access administration and credentials are not proposable' },
    validation: 'adapter',
    request: { body: issueBody },
    response: { status: 200, schema: issued },
    prepare: (env, input) => {
      needsStore(runtime)
      return resetTargetOperation(env, (input.body as z.infer<typeof issueBody>).user_id)
    },
    after: async (value) => {
      const rt = needsStore(runtime)
      const t = value as { email: string; subject: string; actorId: string; auditId: string; now: string }
      const out = await rt.port.issueResetLink({ email: t.email, subject: t.subject, auditId: t.auditId, actorId: t.actorId, now: t.now })
      if (!out) throw new ApiError(404, 'not_found', 'user not found')
      return { url: passwordResetUrl(rt.publicBaseUrl, out.token), expires_at: out.expiresAt }
    },
  }
}
