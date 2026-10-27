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
  type PreparedOperation,
  type Read,
  type StorageBinding,
} from '@vault/storage'
import { ApiError, mapStorageError } from '../errors.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import type { InternalEnv } from '../storage/internal.js'
import { AuthFailure, type AuthAdapter } from './adapter.js'
import type { Role } from './roles.js'

/**
 * A known user and, when the token names an organisation the vault already has, what its copy says: the
 * linked organisation's id and the user's most recently updated membership row there (live or soft-deleted;
 * [[CORE3]] D20). Both are null for first sight, which the caller re-resolves through repair.
 */
export type UserLogin = {
  userId: string
  linkedOrganizationId: string | null
  latestMembership: { role: Role; deletedAt: Date | null; updatedAt: Date } | null
}
type Lookup = { provider: string; subject: string; organizationExternalId: string | null }
type FirstSight = { provider: string; subject: string; email: string; name: string | null; emailVerified: boolean; principalId: string; now: Date }

const INTERNAL = { kind: 'internal', organizationId: null } as const
const accountConflict = () => new ApiError(409, 'account_conflict', 'this email belongs to another account')

// ---- the steady-state lookup (read-only) --------------------------------------------------------------

const USER = 'auth:user'
const ORG = 'auth:org'
const LATEST = 'auth:latest'

/**
 * The steady-state lookup ([[CORE41]] C4): a read-only unit. The user by login; when the token names an organisation, the
 * linked organisation's id and the user's latest membership row there (`updated_at desc, id desc`), live or removed.
 */
export function lookupUserOperation(a: Lookup): PreparedOperation<UserLogin | null> {
  return defineOperation<UserLogin | null>({
    name: 'auth.lookup_user',
    mutates: false,
    reads: (qc) => {
      const reads: Record<string, Read> = {
        [USER]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', a.provider).where('users.auth_subject', '=', a.subject)),
      }
      if (a.organizationExternalId !== null) {
        reads[ORG] = readMaybe(
          qc.db.selectFrom('organizations').select('organizations.id').where('organizations.auth_provider', '=', a.provider).where('organizations.auth_org_id', '=', a.organizationExternalId),
        )
        reads[LATEST] = readMaybe(
          qc.db
            .selectFrom('memberships')
            .innerJoin('users', 'users.id', 'memberships.user_id')
            .innerJoin('organizations', 'organizations.id', 'memberships.organization_id')
            .select(['memberships.role', 'memberships.deleted_at', 'memberships.updated_at'])
            .where('users.auth_provider', '=', a.provider)
            .where('users.auth_subject', '=', a.subject)
            .where('organizations.auth_provider', '=', a.provider)
            .where('organizations.auth_org_id', '=', a.organizationExternalId)
            .orderBy('memberships.updated_at', 'desc')
            .orderBy('memberships.id', 'desc')
            .limit(1),
        )
      }
      return reads
    },
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => {
          const user = found.maybe(USER)
          if (!user) return null
          const org = found.maybe(ORG)
          const latest = found.maybe(LATEST)
          return {
            userId: user.id as string,
            linkedOrganizationId: (org?.id as string | undefined) ?? null,
            latestMembership: latest
              ? {
                  role: latest.role as Role,
                  deletedAt: latest.deleted_at === null ? null : new Date(codecs.timestamp.read(latest.deleted_at)),
                  updatedAt: new Date(codecs.timestamp.read(latest.updated_at)),
                }
              : null,
          }
        },
      }),
  })
}

// ---- first sight ----------------------------------------------------------------------------------------

const SUBJECT = 'auth:subject'
const EMAIL = 'auth:email'

function loginReads(provider: string, subject: string, email: string) {
  return (qc: Parameters<PreparedOperation<unknown>['reads']>[0]): Record<string, Read> => ({
    // ORDER MATTERS (READ COMMITTED, no lock): the email is read BEFORE the subject. A winner commits its subject and email together, so an
    // email seen as held by a winner implies the later subject read sees it too; reading the subject first could see 'absent' then 'email held'
    // and misreport the race as a conflict.
    [EMAIL]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.email', '=', email)),
    [SUBJECT]: readMaybe(qc.db.selectFrom('users').select('users.id').where('users.auth_provider', '=', provider).where('users.auth_subject', '=', subject)),
  })
}

/**
 * First sight of a subject ([[CORE3]] D4, D5, D12; [[CORE36]] D18): ONE internal unit, no lock, no event (identity
 * bookkeeping). The plan reads the subject and the email: a known subject is that login with no statement; the email of
 * another user is `409 account_conflict`. Otherwise: the principal with the application-minted id, the user with ON
 * CONFLICT DO NOTHING, and an assertion that the user row for the subject carries THIS principal's id. A race loser
 * inserts nothing, fails the assertion and drifts: the whole unit rolls back, so it leaves no orphan principal. The
 * assertion is followed only by the ungated result select (D1: a holding assertion resets `changes()`).
 */
export function firstSightOperation(a: FirstSight): PreparedOperation<UserLogin> {
  const at = codecs.timestamp.write(a.now)
  return defineOperation<UserLogin>({
    name: 'auth.first_sight',
    mutates: true,
    reads: loginReads(a.provider, a.subject, a.email),
    build: (found, qc) => {
      const known = found.maybe(SUBJECT)
      if (known) return unit({ steps: [], events: [], decode: () => ({ userId: known.id as string, linkedOrganizationId: null, latestMembership: null }) })
      if (found.maybe(EMAIL)) {
        console.warn('[auth] account_conflict', { provider: a.provider })
        throw accountConflict()
      }
      const principal = qc.db.insertInto('principals').values({ id: a.principalId, kind: 'user', created_at: at })
      const user = qc.db
        .insertInto('users')
        .values({
          id: a.principalId,
          created_at: at,
          updated_at: at,
          email: a.email,
          name: a.name,
          auth_provider: a.provider,
          auth_subject: a.subject,
          email_verified: a.emailVerified,
        })
        .onConflict((oc) => oc.doNothing())
      const holds = sql<SqlBool>`exists (select 1 from "users" where "users"."auth_provider" = ${a.provider} and "users"."auth_subject" = ${a.subject} and "users"."id" = ${a.principalId})`
      const result = qc.db.selectFrom('users').select('users.id').where('users.id', '=', a.principalId)
      return unit({
        steps: [step(principal, 'first-mutation'), step(user), assertStep(qc, holds), step(result, 'result')],
        events: [],
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('auth.first_sight')
          return { userId: rows[0]!.id as string, linkedOrganizationId: null, latestMembership: null }
        },
      })
    },
  })
}

/**
 * The read-only recheck after a first-sight drift ([[CORE36]] D18): the winner's login, `409 account_conflict` when the
 * email is now held by someone else, `409 conflict` when neither. It cannot write, so it cannot loop.
 */
export function firstSightRecheckOperation(a: { provider: string; subject: string; email: string }): PreparedOperation<UserLogin> {
  return defineOperation<UserLogin>({
    name: 'auth.first_sight_recheck',
    mutates: false,
    reads: loginReads(a.provider, a.subject, a.email),
    build: (found) => {
      const known = found.maybe(SUBJECT)
      if (known) return unit({ steps: [], events: [], decode: () => ({ userId: known.id as string, linkedOrganizationId: null, latestMembership: null }) })
      if (found.maybe(EMAIL)) throw accountConflict()
      throw new ApiError(409, 'conflict', 'the record changed while the operation was running; retry')
    },
  })
}

/** The steady-state lookup: one read-only internal unit. */
export async function lookupUser(storage: StorageBinding, a: Lookup): Promise<UserLogin | null> {
  return (await execute(storage, INTERNAL, lookupUserOperation(a))).value
}

/**
 * First sight with its network and normalisation outside any unit ([[CORE3]] D4, D5, D12): the profile fetch, then the
 * email check and normalisation (`400 invalid_identity`, D7), then the unit; on drift ONE read-only recheck.
 */
export async function provisionUser(storage: StorageBinding, adapter: AuthAdapter, subject: string, env: InternalEnv): Promise<UserLogin> {
  const profile = await adapter.fetchProfile(subject)
  const raw = profile.email?.trim()
  if (!raw) {
    console.warn('[auth] first sight: provider returned no email', { provider: adapter.provider })
    throw new AuthFailure('no_email', 'account has no email address')
  }
  const email = normalizeIdentityValue('email', raw)
  const args = { provider: adapter.provider, subject, email }
  try {
    return (
      await execute(
        storage,
        INTERNAL,
        firstSightOperation({ ...args, name: profile.name, emailVerified: profile.emailVerified, principalId: env.newId(), now: env.now }),
      )
    ).value
  } catch (err) {
    if (!(err instanceof UnitDriftError)) throw mapStorageError(err)
  }
  try {
    return (await execute(storage, INTERNAL, firstSightRecheckOperation(args))).value
  } catch (err) {
    throw mapStorageError(err)
  }
}
