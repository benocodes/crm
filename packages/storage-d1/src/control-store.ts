// The control store ([[CORE259]] D5): the ONE module below composition that holds the control-plane database. `ControlDb` is an opaque handle, deliberately not a `D1Like`:
// the storage runtime (`d1Binding`) and everything the operations, the registry and any SQL or DDL path receive wrap the CRM database only, and the type system refuses
// the control handle there. Composition opens the handle from `CONTROL_DB` and hands it to the auth provider (`controlAuthDatabase`) and to this module's few functions.
// The surface is the marker ([[CORE259]] D7) and the tracker read; the control-plane resources and the audit log arrive with [[CORE261]].
import type { D1Like, D1PreparedLike } from './binding.js'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { readMigrationState, type MigrationState } from './migration-state.js'
import { classifySweep, orphanCutoff, parseSweepControlRows, parseSweepCrmRows, type SweepPlan } from './auth-sweep.js'

const handles = new WeakMap<ControlDb, D1Like>()

/** The control-plane database. Not a `D1Like`: it has no `prepare` or `batch`, so it cannot be wrapped by `d1Binding` or stored as a storage runtime. */
export class ControlDb {
  readonly #control = true
  constructor(d1: D1Like) {
    handles.set(this, d1)
  }
}

/** Opens the handle on the `CONTROL_DB` binding. Composition and bootstrap call this; nothing else has the binding. */
export const openControlDb = (d1: D1Like): ControlDb => new ControlDb(d1)

const raw = (c: ControlDb): D1Like => {
  const d1 = handles.get(c)
  if (!d1) throw new Error('not a control database handle')
  return d1
}

/** The database the auth provider is composed on: Better Auth reads and writes the control plane, never the CRM database ([[CORE259]] D3). */
export const controlAuthDatabase = (c: ControlDb): { prepare(query: string): unknown } => raw(c)

/** The control marker: the one organisation this control plane serves. `null` when the table holds no row (a control database nobody has paired). */
export async function readControlMarker(c: ControlDb): Promise<{ organizationId: string } | null> {
  const row = await raw(c).prepare('select organization_id from control_deployment where singleton = 1').first()
  return row ? { organizationId: row.organization_id as string } : null
}

/**
 * Writes the control marker ([[CORE259]] D7), after the CRM `deployment` row. Idempotent: the same organisation is `'existing'` and writes nothing; another organisation is
 * refused. Machinery, not a resource: no event (AGENTS.md invariant 5 names bootstrap; the control plane has its own audit log in [[CORE261]]).
 */
export async function writeControlMarker(c: ControlDb, organizationId: string): Promise<'created' | 'existing'> {
  const conflict = (other: string) => new Error(`the control database is already paired with organization ${other}`)
  const existing = await readControlMarker(c)
  if (existing) {
    if (existing.organizationId !== organizationId) throw conflict(existing.organizationId)
    return 'existing'
  }
  await raw(c)
    .prepare('insert into control_deployment (singleton, organization_id) values (1, ?) on conflict do nothing')
    .bind(organizationId)
    .run()
  const now = await readControlMarker(c)
  if (!now || now.organizationId !== organizationId) throw conflict(now?.organizationId ?? 'unknown')
  return 'created'
}

/** The tracker against this build's control manifest ([[CORE259]] D4): the same comparison as the CRM database's ([[CORE61]]). */
export function readControlMigrations(c: ControlDb): Promise<MigrationState> {
  return readMigrationState(
    raw(c),
    CONTROL_MIGRATIONS.map((m) => m.name),
  )
}

/** A signing key as `auth_jwks` holds it: the key id Better Auth puts in a token's `kid`, its algorithm (`EdDSA` unless the row says otherwise) and the public JWK as JSON text. */
export interface AuthJwk {
  kid: string
  alg: string
  publicJwk: string
}

/**
 * Every public signing key of the built-in provider ([[CORE244]] P1): one read of `auth_jwks`, no private key column. The adapter caches the result per isolate; this is the only reader.
 * Rotated keys stay in the table, so a token signed by an older key still verifies until the operator removes the row.
 */
export async function readAuthJwks(c: ControlDb): Promise<AuthJwk[]> {
  const res = await raw(c).prepare('select id, alg, public_key from auth_jwks').all()
  return ((res.results ?? []) as Array<{ id: string; alg: string | null; public_key: string }>).map((r) => ({
    kid: r.id,
    alg: r.alg ?? 'EdDSA',
    publicJwk: r.public_key,
  }))
}

/** The Better Auth account behind a token's subject ([[CORE244]] D9): what first sight of a delegated agent's human needs. `null` when no such account. */
export async function readAuthProfile(
  c: ControlDb,
  userId: string,
): Promise<{ email: string; emailVerified: boolean; name: string } | null> {
  const row = await raw(c)
    .prepare('select email, email_verified, name from auth_users where id = ?')
    .bind(userId)
    .first()
  return row
    ? { email: row.email as string, emailVerified: Number(row.email_verified) === 1, name: row.name as string }
    : null
}

/** The display name of an OAuth client by its client id ([[CORE244]] D9); `null` when the provider has no such client or it has no name. */
export async function readOAuthClientName(c: ControlDb, clientId: string): Promise<string | null> {
  const row = await raw(c).prepare('select name from auth_oauth_clients where client_id = ?').bind(clientId).first()
  return typeof row?.name === 'string' && row.name !== '' ? row.name : null
}

// ---- Invitations and the audit log ([[CORE245]], [[CORE259]] D3, D9 (c), D12). Every write is ONE control batch: the change and its `control_audit` row commit together or not at all. ----
export type InvitationRole = 'owner' | 'member' | 'agent'
/** An invitation as the control plane holds it, without its token or token hash (neither is ever read back). Timestamps are ISO-8601 text. */
export interface InvitationRecord {
  id: string
  organizationId: string
  email: string
  role: InvitationRole
  expiresAt: string
  createdBy: string
  createdAt: string
  acceptedAt: string | null
  revokedAt: string | null
  /** How it reached its address ([[CORE248]] D3): `email` when the vault sent it and never returned the token, else `link`. */
  delivery: InvitationDelivery
}
export type InvitationDelivery = 'link' | 'email'
export interface NewInvitation {
  id: string
  /** The `control_audit` row written in the same batch. */
  auditId: string
  organizationId: string
  email: string
  role: InvitationRole
  tokenHash: string
  expiresAt: string
  createdBy: string
  /** [[CORE248]] D3; absent is `link`. */
  delivery?: InvitationDelivery
  /** The unit's clock: `created_at`, the audit `at`, and what "live" is judged against. */
  now: string
}

const COLUMNS =
  'id, organization_id, email, role, expires_at, created_by, created_at, accepted_at, revoked_at, delivery'
const recordOf = (r: Record<string, unknown>): InvitationRecord => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  email: r.email as string,
  role: r.role as InvitationRole,
  expiresAt: r.expires_at as string,
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
  acceptedAt: (r.accepted_at as string | null) ?? null,
  revokedAt: (r.revoked_at as string | null) ?? null,
  delivery: r.delivery === 'email' ? 'email' : 'link',
})
/** An invitation is live while it is not accepted, not revoked and `expires_at` is after `now` (ISO text compares as time). */
const LIVE = 'accepted_at is null and revoked_at is null and expires_at > ?'

/** The `control_audit` insert for an invitation change, written only when the invitation row is in the state the change leaves it in (`guard`, a SQL condition on the same `id`). */
const auditStatement = (
  d1: D1Like,
  a: {
    auditId: string
    now: string
    actorId: string
    action: string
    invitationId: string
    guard: string
    guardBinds: unknown[] /** Created rows carry the delivery ([[CORE248]] D3). */
    withDelivery?: boolean /** A revoke's reason (`email_failed`). */
    reason?: string
  },
) =>
  d1
    .prepare(
      `insert into control_audit (id, at, actor_id, action, target_type, target_id, detail)
       select ?, ?, ?, ?, 'invitation', id, json_object('email', email, 'role', role, 'expires_at', expires_at${a.withDelivery ? ", 'delivery', delivery" : ''}${a.reason === undefined ? '' : ", 'reason', ?"})
       from invitations where id = ? and ${a.guard}`,
    )
    .bind(
      a.auditId,
      a.now,
      a.actorId,
      a.action,
      ...(a.reason === undefined ? [] : [a.reason]),
      a.invitationId,
      ...a.guardBinds,
    )

const insertStatements = (d1: D1Like, a: NewInvitation): D1PreparedLike[] => [
  // Guarded insert: nothing is written when another live invitation holds the address (the one-live-per-email rule, judged in the same statement that writes).
  d1
    .prepare(
      `insert into invitations (id, organization_id, email, role, expires_at, created_by, created_at, accepted_at, revoked_at, token_hash, delivery)
       select ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?
       where not exists (select 1 from invitations where email = ? and ${LIVE})`,
    )
    .bind(
      a.id,
      a.organizationId,
      a.email,
      a.role,
      a.expiresAt,
      a.createdBy,
      a.now,
      a.tokenHash,
      a.delivery ?? 'link',
      a.email,
      a.now,
    ),
  auditStatement(d1, {
    auditId: a.auditId,
    now: a.now,
    actorId: a.createdBy,
    action: 'invitation.created',
    invitationId: a.id,
    guard: '1 = 1',
    guardBinds: [],
    withDelivery: true,
  }),
]

/** Creates an invitation and its `invitation.created` audit row in one batch; `live_exists` (nothing written) when a live invitation already holds the address. */
export async function createInvitation(c: ControlDb, a: NewInvitation): Promise<'created' | 'live_exists'> {
  const d1 = raw(c)
  const results = await d1.batch(insertStatements(d1, a))
  return (results[0]?.meta?.changes ?? 0) === 1 ? 'created' : 'live_exists'
}

/** One page of invitations in id order (UUIDv7, so creation order), after the cursor. Never selects the token hash. */
export async function listInvitations(c: ControlDb, a: { after?: string; limit: number }): Promise<InvitationRecord[]> {
  const res = await raw(c)
    .prepare(`select ${COLUMNS} from invitations ${a.after ? 'where id > ?' : ''} order by id limit ?`)
    .bind(...(a.after ? [a.after] : []), a.limit)
    .all()
  return ((res.results ?? []) as Array<Record<string, unknown>>).map(recordOf)
}

/** A `control_audit` row as stored; `detail` is the stored JSON parsed. */
export interface ControlAuditRecord {
  id: string
  at: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  detail: unknown
}

/** One page of the audit log in id order after the cursor, with optional exact-match filters ([[CORE261]] P3). Reads only. */
export async function listControlAudit(
  c: ControlDb,
  a: { after?: string; limit: number; action?: string; targetType?: string; targetId?: string },
): Promise<ControlAuditRecord[]> {
  const where: string[] = []
  const binds: unknown[] = []
  for (const [column, value] of [
    ['id >', a.after],
    ['action =', a.action],
    ['target_type =', a.targetType],
    ['target_id =', a.targetId],
  ] as const)
    if (value !== undefined) {
      where.push(`${column} ?`)
      binds.push(value)
    }
  const res = await raw(c)
    .prepare(
      `select id, at, actor_id, action, target_type, target_id, detail from control_audit ${where.length ? `where ${where.join(' and ')}` : ''} order by id limit ?`,
    )
    .bind(...binds, a.limit)
    .all()
  return ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    at: r.at as string,
    actorId: r.actor_id as string,
    action: r.action as string,
    targetType: r.target_type as string,
    targetId: r.target_id as string,
    detail: JSON.parse(r.detail as string),
  }))
}

const readInvitation = async (d1: D1Like, id: string): Promise<InvitationRecord | null> => {
  const row = await d1.prepare(`select ${COLUMNS} from invitations where id = ?`).bind(id).first()
  return row ? recordOf(row) : null
}

/**
 * Revokes a live invitation and writes its `invitation.revoked` audit row in one batch. `not_live` (nothing written) for one that is accepted, revoked or expired, with the
 * record as it is; `not_found` for an unknown id.
 */
export async function revokeInvitation(
  c: ControlDb,
  a: {
    id: string
    auditId: string
    actorId: string
    now: string /** Recorded in the audit `detail` ([[CORE248]] D3: `email_failed`). */
    reason?: string
  },
): Promise<{ result: 'revoked' | 'not_live'; record: InvitationRecord } | { result: 'not_found' }> {
  const d1 = raw(c)
  const results = await d1.batch([
    d1.prepare(`update invitations set revoked_at = ? where id = ? and ${LIVE}`).bind(a.now, a.id, a.now),
    auditStatement(d1, {
      auditId: a.auditId,
      now: a.now,
      actorId: a.actorId,
      action: 'invitation.revoked',
      invitationId: a.id,
      guard: 'revoked_at = ? and changes() = 1',
      guardBinds: [a.now],
      ...(a.reason === undefined ? {} : { reason: a.reason }),
    }),
  ])
  const record = await readInvitation(d1, a.id)
  if (!record) return { result: 'not_found' }
  return { result: (results[0]?.meta?.changes ?? 0) === 1 ? 'revoked' : 'not_live', record }
}

/**
 * The owner invitation of bootstrap ([[CORE245]] P7) and of `owner-reset` when no owner exists ([[OPS307]] D11): every live OWNER invitation is revoked and a fresh one created in ONE control batch,
 * each change with its audit row, and NOTHING is read first, so an owner invitation created at any moment before the batch runs is revoked with the rest. Every statement carries the same guard
 * (P1), "no live non-owner invitation for this email": when one exists the insert is refused (`live_exists`) and the revoke and its audit rows write nothing either. The revoke audit rows are one
 * `insert … select` over the live owner invitations; each row's id takes its first 24 characters from one fresh id (`newAuditId()`, time-ordered) and its last 12 from the invitation's own id, which
 * keeps the 36-character shape and is distinct per row. `revoked` is how many owner invitations the batch revoked.
 */
export async function reissueOwnerInvitation(
  c: ControlDb,
  a: NewInvitation & { newAuditId: () => string },
): Promise<{ result: 'created'; revoked: number } | { result: 'live_exists' }> {
  const d1 = raw(c)
  const noBlocker = `not exists (select 1 from invitations where email = ? and role <> 'owner' and ${LIVE})`
  const results = await d1.batch([
    d1
      .prepare(
        `insert into control_audit (id, at, actor_id, action, target_type, target_id, detail)
         select substr(?, 1, 24) || substr(id, 25, 12), ?, ?, 'invitation.revoked', 'invitation', id, json_object('email', email, 'role', role, 'expires_at', expires_at)
         from invitations where role = 'owner' and ${LIVE} and ${noBlocker}`,
      )
      .bind(a.newAuditId(), a.now, a.createdBy, a.now, a.email, a.now),
    d1
      .prepare(`update invitations set revoked_at = ? where role = 'owner' and ${LIVE} and ${noBlocker}`)
      .bind(a.now, a.now, a.email, a.now),
    ...insertStatements(d1, a),
  ])
  if ((results[2]?.meta?.changes ?? 0) !== 1) return { result: 'live_exists' }
  return { result: 'created', revoked: results[1]?.meta?.changes ?? 0 }
}

// ---- Sign-up gate and acceptance ([[CORE287]] P2, P4, P5). ----

/**
 * The sign-up gate's one read ([[CORE287]] P2): is there a LIVE invitation for this email whose token hashes to `tokenHash`? Never tells a caller which condition failed (missing, other email, expired,
 * revoked, accepted are all `false`); the email is compared as stored (trimmed, lowercased by the caller).
 */
export async function hasLiveInvitationForToken(
  c: ControlDb,
  a: { tokenHash: string; email: string; now: string },
): Promise<boolean> {
  const row = await raw(c)
    .prepare(`select 1 as ok from invitations where token_hash = ? and email = ? and ${LIVE}`)
    .bind(a.tokenHash, a.email, a.now)
    .first()
  return row !== null && row !== undefined
}

/**
 * The LIVE invitation for this email whose token hashes to `tokenHash` ([[CORE302]] P1), or null for every failing cause alike: the re-admission of a removed member reads its role and delivery from it.
 */
export async function findLiveInvitationByToken(
  c: ControlDb,
  a: { tokenHash: string; email: string; now: string },
): Promise<InvitationRecord | null> {
  const row = await raw(c)
    .prepare(`select ${COLUMNS} from invitations where token_hash = ? and email = ? and ${LIVE}`)
    .bind(a.tokenHash, a.email, a.now)
    .first()
  return row ? recordOf(row) : null
}

/**
 * The invitation that admitted an account ([[CORE287]] P5): LIVE for this email and created no later than the account. A fresh invitation made after the account never adopts it. `accountCreatedAt` is
 * the caller's ISO-8601 text with milliseconds and a Z (Better Auth's own column holds another encoding; the caller converts it through a `Date`), so the comparison is text on one encoding.
 */
export async function findAdoptableInvitation(
  c: ControlDb,
  a: { email: string; accountCreatedAt: string; now: string },
): Promise<InvitationRecord | null> {
  const row = await raw(c)
    .prepare(`select ${COLUMNS} from invitations where email = ? and ${LIVE} and created_at <= ?`)
    .bind(a.email, a.now, a.accountCreatedAt)
    .first()
  return row ? recordOf(row) : null
}

/**
 * Marks a still-LIVE invitation accepted and writes its `invitation.accepted` audit row, in one batch ([[CORE287]] P4). `not_live` (nothing written) when a revoke, an expiry or an earlier
 * acceptance got there first.
 */
export async function acceptInvitation(
  c: ControlDb,
  a: { id: string; auditId: string; actorId: string; now: string },
): Promise<'accepted' | 'not_live'> {
  const d1 = raw(c)
  const results = await d1.batch([
    d1.prepare(`update invitations set accepted_at = ? where id = ? and ${LIVE}`).bind(a.now, a.id, a.now),
    auditStatement(d1, {
      auditId: a.auditId,
      now: a.now,
      actorId: a.actorId,
      action: 'invitation.accepted',
      invitationId: a.id,
      guard: 'accepted_at = ? and changes() = 1',
      guardBinds: [a.now],
    }),
  ])
  return (results[0]?.meta?.changes ?? 0) === 1 ? 'accepted' : 'not_live'
}

// ---- Membership removal and owner-issued reset links ([[CORE288]] P5, P6). Each write is one control batch with its `control_audit` row. ----

/**
 * The credentials of a removed member's Better Auth account ([[CORE288]] P5, [[CORE259]] D9 (b)): its OAuth access and refresh tokens, its sessions and its pending device codes are deleted, and one
 * `user.sessions_revoked` audit row (actor the caller, target the Better Auth user id, `detail` `{reason: 'membership_removed'}`, never a token) is written, in ONE batch. Consents and the account stay. Running it
 * again deletes nothing and writes another audit row, which is why the caller runs it once per removal.
 */
export async function revokeSubjectCredentials(
  c: ControlDb,
  a: { subject: string; auditId: string; actorId: string; now: string },
): Promise<void> {
  const d1 = raw(c)
  await d1.batch([
    d1.prepare('delete from auth_oauth_access_tokens where user_id = ?').bind(a.subject),
    d1.prepare('delete from auth_oauth_refresh_tokens where user_id = ?').bind(a.subject),
    d1.prepare('delete from auth_device_codes where user_id = ?').bind(a.subject),
    d1.prepare('delete from auth_sessions where user_id = ?').bind(a.subject),
    d1
      .prepare(
        "insert into control_audit (id, at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, 'user.sessions_revoked', 'user', ?, json_object('reason', 'membership_removed'))",
      )
      .bind(a.auditId, a.now, a.actorId, a.subject),
  ])
}

/** The audit row of an owner-issued reset link ([[CORE288]] P6): actor the caller, target the Better Auth user id, `detail` holding the expiry only, never the token. */
export async function recordResetLinkIssued(
  c: ControlDb,
  a: {
    auditId: string
    actorId: string
    subject: string
    expiresAt: string
    now: string /** How the link was issued ([[OPS307]] D10): `owner-reset` from the operator command; absent from the owner's API call. */
    via?: string
  },
): Promise<void> {
  await raw(c)
    .prepare(
      `insert into control_audit (id, at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, 'user.reset_link_issued', 'user', ?, json_object('expires_at', ?${a.via === undefined ? '' : ", 'via', ?"}))`,
    )
    .bind(a.auditId, a.now, a.actorId, a.subject, a.expiresAt, ...(a.via === undefined ? [] : [a.via]))
    .run()
}

// ---- The repair sweep ([[CORE259]] D10, [[CORE289]]). The statements are here because the auth tables are named only in this module (auth-machinery.test.ts); the pure facts and classifier are `auth-sweep.ts`. ----
/**
 * The control-plane read: one result set, a `kind` column and five generic columns. `user`: id, email, created_at. `credential`: a user id that still has a session, refresh token, access token
 * or device code. `invitation`: email, created_at, accepted_at, revoked_at, expires_at.
 */
export const SWEEP_CONTROL_READ = `select 'user' as kind, id as k1, email as k2, created_at as k3, null as k4, null as k5 from auth_users
union all select 'credential', user_id, null, null, null, null from (select user_id from auth_sessions union select user_id from auth_oauth_refresh_tokens union select user_id from auth_oauth_access_tokens union select user_id from auth_device_codes) where user_id is not null
union all select 'invitation', email, created_at, accepted_at, revoked_at, expires_at from invitations`

/** The CRM read: every Better Auth subject a CRM user or agent names, and whether it still has authority (a live membership; an enabled agent). */
export const SWEEP_CRM_READ = `select u.auth_subject as subject, case when exists (select 1 from memberships m where m.user_id = u.id and m.deleted_at is null) then 1 else 0 end as authority from users u where u.auth_provider = 'better-auth' and u.auth_subject is not null
union all select a.auth_subject, case when a.disabled_at is null then 1 else 0 end from agents a where a.auth_provider = 'better-auth' and a.auth_subject is not null`

/** The SQL condition, over an `auth_users` row, that an invitation keeps the account: for its email, created no later than the account, and accepted or still live at `?`. One bind: the instant. */
export const KEEPING_INVITATION = `exists (select 1 from invitations i where i.email = lower(auth_users.email) and i.created_at <= auth_users.created_at and (i.accepted_at is not null or (i.revoked_at is null and i.expires_at > ?)))`

export interface AuthSweepOutcome {
  /** Linked subjects without authority whose credentials were deleted. */
  revoked: number
  /** Orphan accounts deleted. */
  deleted: number
}

/** Subject ids per statement: one JSON-array bind each (`json_each`), so D1's 100-parameter cap never applies, and the text stays small. */
const SWEEP_CHUNK = 500
const chunks = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / SWEEP_CHUNK) }, (_, i) => xs.slice(i * SWEEP_CHUNK, (i + 1) * SWEEP_CHUNK))

/** The one control batch of a sweep ([[CORE289]] P1-P3): nothing else is written. Revocation deletes only credentials created before `credentialsBefore` (the sweep's CRM read), and the deletion re-checks age and invitations in its own statements. */
function sweepStatements(d1: D1Like, plan: SweepPlan, a: { now: string; credentialsBefore: string }): D1PreparedLike[] {
  const statements: D1PreparedLike[] = []
  for (const ids of chunks(plan.revoke)) {
    const list = JSON.stringify(ids)
    const own = 'user_id in (select value from json_each(?))'
    statements.push(
      d1
        .prepare(`delete from auth_oauth_access_tokens where ${own} and created_at < ?`)
        .bind(list, a.credentialsBefore),
      d1
        .prepare(`delete from auth_oauth_refresh_tokens where ${own} and created_at < ?`)
        .bind(list, a.credentialsBefore),
      d1.prepare(`delete from auth_sessions where ${own} and created_at < ?`).bind(list, a.credentialsBefore),
      // A device code has no creation time to bound by.
      d1.prepare(`delete from auth_device_codes where ${own}`).bind(list),
    )
  }
  const cutoff = orphanCutoff(a.now)
  for (const ids of chunks(plan.orphans)) {
    const list = JSON.stringify(ids)
    const orphan = `id in (select value from json_each(?)) and created_at < ? and not ${KEEPING_INVITATION}`
    // Device codes name the user without a foreign key, so they go first, under the same guard that decides the account.
    statements.push(
      d1
        .prepare(`delete from auth_device_codes where user_id in (select id from auth_users where ${orphan})`)
        .bind(list, cutoff, a.now),
    )
    statements.push(d1.prepare(`delete from auth_users where ${orphan}`).bind(list, cutoff, a.now))
  }
  return statements
}

/**
 * One sweep ([[CORE259]] D10, [[CORE289]]): control facts, then the CRM's, then ONE control batch. A failed read throws before anything is written; a failed batch writes nothing; the next tick
 * retries. Writes no audit row and nothing in the CRM database. `crm` is only read.
 */
export async function runAuthSweep(c: ControlDb, crm: D1Like, clock: () => Date): Promise<AuthSweepOutcome> {
  const d1 = raw(c)
  const now = clock().toISOString()
  const control = parseSweepControlRows(((await d1.prepare(SWEEP_CONTROL_READ).all()).results ?? []) as unknown[])
  // Credentials created after this instant belong to something that began after the CRM was read (an acceptance's sign-in): they survive this sweep.
  const credentialsBefore = clock().toISOString()
  const facts = parseSweepCrmRows(((await crm.prepare(SWEEP_CRM_READ).all()).results ?? []) as unknown[])
  const plan = classifySweep({ now, control, crm: facts })
  if (plan.revoke.length === 0 && plan.orphans.length === 0) return { revoked: 0, deleted: 0 }
  await d1.batch(sweepStatements(d1, plan, { now, credentialsBefore }))
  // The batch's own change counts include cascaded rows, so the deletions are counted by what is gone.
  let remaining = 0
  for (const ids of chunks(plan.orphans))
    remaining += Number(
      (
        (await d1
          .prepare('select count(*) as n from auth_users where id in (select value from json_each(?))')
          .bind(JSON.stringify(ids))
          .first()) ?? { n: 0 }
      ).n,
    )
  return { revoked: plan.revoke.length, deleted: plan.orphans.length - remaining }
}

// ---- Webhooks in the control plane ([[CORE327]], [[CORE259]] D3, D5, D8, D9 (c), D12; dormant until [[CORE337]]). The four tables of control 0004. The store stores: ids, `now`, the sealed secret and every fact that
// lives in the CRM database (an agent's eligibility and scopes, an event's id) arrive BY VALUE from the caller (P4); nothing here reads the CRM database. A subscription change is ONE batch with its
// `control_audit` row (P2); machinery (dispatch, deliveries, leases, attempts) writes no audit row (P3). ----
export type WebhookStatus = 'active' | 'paused' | 'disabled'
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'dead' | 'cancelled'
export interface WebhookSubscriptionRecord {
  id: string
  organizationId: string
  agentId: string
  url: string
  eventTypes: string[]
  status: WebhookStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}
export interface WebhookDeliveryRecord {
  id: string
  subscriptionId: string
  eventId: string
  eventType: string
  status: WebhookDeliveryStatus
  attempts: number
  nextAttemptAt: string
  lastAttemptAt: string | null
  lastStatusCode: number | null
  lastError: string | null
  deliveredAt: string | null
  createdAt: string
}
/** The previous secret still signs for this long after a rotation ([[API7]] D12); the same constant as `@vibase/api`'s `ROTATION_OVERLAP_MS`. */
export const WEBHOOK_ROTATION_OVERLAP_MS = 24 * 3_600_000

export interface WebhookDispatchTarget {
  subscriptionId: string
  createdBy: string
  agentId: string
  eventTypes: string[]
  cursor: string
}
export interface WebhookDueDelivery {
  id: string
  subscriptionId: string
  eventId: string
  /** Attempts before this claim. */
  attempts: number
  url: string
  deleted: boolean
  agentId: string
}
export type WebhookDeliveryOutcome =
  | { id: string; subscriptionId: string; kind: 'delivered'; statusCode: number }
  | {
      id: string
      subscriptionId: string
      kind: 'failed'
      code: string
      statusCode: number | null
      nextAttemptAt: string | null
      dead: boolean
    }
  | { id: string; subscriptionId: string; kind: 'cancelled'; code: string }
export interface NewWebhookSubscription {
  id: string
  secretId: string
  auditId: string
  organizationId: string
  /** The calling principal: `created_by` of every row and the audit `actor_id`. */
  actorId: string
  agentId: string
  url: string
  eventTypes: string[]
  /** The secret, sealed by the caller under `CREDENTIALS_KEY`. */
  sealed: string
  keyVersion: number
  /** The newest event's id, read by the caller from the CRM feed: the dispatch position at creation ([[API7]] D5). */
  cursorEventId: string
  /** [[API7]] D16: the caller's limit of live subscriptions per agent. */
  maxLivePerAgent: number
  now: string
}
export interface WebhookChange {
  id: string
  auditId: string
  actorId: string
  now: string
  /** The `updated_at` the caller read: the write applies only while the row still carries it. */
  expectedUpdatedAt: string
  /** An agent caller's own id: a subscription of another agent is `not_found` ([[API7]] D1). */
  ownerAgentId?: string
}

const WEBHOOK_COLUMNS = 'id, organization_id, agent_id, url, event_types, status, created_by, created_at, updated_at'
const webhookOf = (r: Record<string, unknown>): WebhookSubscriptionRecord => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  agentId: r.agent_id as string,
  url: r.url as string,
  eventTypes: JSON.parse(r.event_types as string) as string[],
  status: r.status as WebhookStatus,
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
})
/** The origin of a target URL, the only part of it an audit row may hold: a receiver may put a token in the path or query. */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
const OWNER = ' and (? is null or agent_id = ?)'
const owner = (id: string | undefined): unknown[] => [id ?? null, id ?? null]
const AUDIT_INSERT = 'insert into control_audit (id, at, actor_id, action, target_type, target_id, detail)'
const SUBSCRIPTION_EXISTS = 'exists (select 1 from webhook_subscriptions where id = ?)'

/**
 * Creates a subscription, its first secret and its dispatch state at `cursorEventId`, with its `webhook.created` audit row, in ONE batch ([[CORE259]] D9 (c), D12). `limit` (nothing written) when the
 * agent already holds `maxLivePerAgent` live subscriptions: the count is judged in the statement that inserts, and every other statement is guarded on the subscription existing. Whether the agent is
 * eligible, the event types and the URL are the caller's to judge (P4).
 */
export async function createWebhookSubscription(c: ControlDb, a: NewWebhookSubscription): Promise<'created' | 'limit'> {
  const d1 = raw(c)
  const detail = JSON.stringify({
    agent_id: a.agentId,
    event_types: a.eventTypes,
    status: 'active',
    url_origin: originOf(a.url),
  })
  const results = await d1.batch([
    d1
      .prepare(
        `insert into webhook_subscriptions (id, created_at, updated_at, organization_id, created_by, agent_id, url, event_types, status, deleted_at)
         select ?, ?, ?, ?, ?, ?, ?, ?, 'active', null
         where (select count(*) from webhook_subscriptions where agent_id = ? and deleted_at is null) < ?`,
      )
      .bind(
        a.id,
        a.now,
        a.now,
        a.organizationId,
        a.actorId,
        a.agentId,
        a.url,
        JSON.stringify(a.eventTypes),
        a.agentId,
        a.maxLivePerAgent,
      ),
    d1
      .prepare(
        `insert into webhook_secrets (id, created_at, organization_id, created_by, subscription_id, sealed, key_version)
         select ?, ?, ?, ?, ?, ?, ? where ${SUBSCRIPTION_EXISTS}`,
      )
      .bind(a.secretId, a.now, a.organizationId, a.actorId, a.id, a.sealed, a.keyVersion, a.id),
    d1
      .prepare(
        `insert into webhook_dispatch_state (subscription_id, created_at, organization_id, created_by, cursor_event_id, last_dispatched_at, last_success_at)
         select ?, ?, ?, ?, ?, null, null where ${SUBSCRIPTION_EXISTS}`,
      )
      .bind(a.id, a.now, a.organizationId, a.actorId, a.cursorEventId, a.id),
    d1
      .prepare(
        `${AUDIT_INSERT} select ?, ?, ?, 'webhook.created', 'webhook', id, json(?) from webhook_subscriptions where id = ?`,
      )
      .bind(a.auditId, a.now, a.actorId, detail, a.id),
  ])
  return (results[0]?.meta?.changes ?? 0) === 1 ? 'created' : 'limit'
}

/** Why a guarded update or delete changed nothing: the subscription is gone or not the caller's (`not_found`), or it is there but no longer as the caller read it (`drifted`). */
const refusal = async (c: ControlDb, a: { id: string; ownerAgentId?: string }): Promise<'not_found' | 'drifted'> =>
  (await getWebhookSubscription(c, a)) === null ? 'not_found' : 'drifted'

/**
 * Updates a live subscription (`url`, `eventTypes`, `status`) and writes `webhook.updated` in one batch. Applies only while the row is live and still carries `expectedUpdatedAt`; otherwise nothing is
 * written, audit row included: `not_found` (missing, deleted or another agent's) or `drifted`. At least one field must change (the empty update is the operation's no-op, never a store write).
 */
export async function updateWebhookSubscription(
  c: ControlDb,
  a: WebhookChange & { url?: string; eventTypes?: string[]; status?: 'active' | 'paused' },
): Promise<'updated' | 'not_found' | 'drifted'> {
  const changed: string[] = []
  const detail: Record<string, unknown> = {}
  const sets: string[] = ['updated_at = ?']
  const binds: unknown[] = [a.now]
  if (a.url !== undefined) {
    changed.push('url')
    detail.url_origin = originOf(a.url)
    sets.push('url = ?')
    binds.push(a.url)
  }
  if (a.eventTypes !== undefined) {
    changed.push('event_types')
    detail.event_types = a.eventTypes
    sets.push('event_types = ?')
    binds.push(JSON.stringify(a.eventTypes))
  }
  if (a.status !== undefined) {
    changed.push('status')
    detail.status = a.status
    sets.push('status = ?')
    binds.push(a.status)
  }
  if (changed.length === 0) throw new Error('webhook update: nothing to change')
  const d1 = raw(c)
  const results = await d1.batch([
    d1
      .prepare(
        `update webhook_subscriptions set ${sets.join(', ')} where id = ? and deleted_at is null and updated_at = ?${OWNER}`,
      )
      .bind(...binds, a.id, a.expectedUpdatedAt, ...owner(a.ownerAgentId)),
    d1
      .prepare(
        `${AUDIT_INSERT} select ?, ?, ?, 'webhook.updated', 'webhook', id, json(?) from webhook_subscriptions where id = ? and updated_at = ? and deleted_at is null`,
      )
      .bind(a.auditId, a.now, a.actorId, JSON.stringify({ changed, ...detail }), a.id, a.now),
  ])
  return (results[0]?.meta?.changes ?? 0) === 1 ? 'updated' : refusal(c, a)
}

/** Soft-deletes a live subscription (`deleted_at` set, the row and its machinery rows kept) and writes `webhook.deleted` in one batch; same guards and refusals as the update. */
export async function deleteWebhookSubscription(
  c: ControlDb,
  a: WebhookChange,
): Promise<'deleted' | 'not_found' | 'drifted'> {
  const d1 = raw(c)
  const results = await d1.batch([
    d1
      .prepare(
        `update webhook_subscriptions set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null and updated_at = ?${OWNER}`,
      )
      .bind(a.now, a.now, a.id, a.expectedUpdatedAt, ...owner(a.ownerAgentId)),
    d1
      .prepare(
        `${AUDIT_INSERT} select ?, ?, ?, 'webhook.deleted', 'webhook', id, json_object('agent_id', agent_id) from webhook_subscriptions where id = ? and deleted_at = ?`,
      )
      .bind(a.auditId, a.now, a.actorId, a.id, a.now),
  ])
  return (results[0]?.meta?.changes ?? 0) === 1 ? 'deleted' : refusal(c, a)
}

/** Rotates the signing secret: a NEW sealed secret row (rows are never updated) for a live subscription, and `webhook.secret_rotated` holding the new row's id, in one batch. `not_found` writes nothing. */
export async function rotateWebhookSecret(
  c: ControlDb,
  a: {
    id: string
    secretId: string
    auditId: string
    actorId: string
    sealed: string
    keyVersion: number
    now: string
    ownerAgentId?: string
  },
): Promise<'rotated' | 'not_found'> {
  const d1 = raw(c)
  const results = await d1.batch([
    d1
      .prepare(
        `insert into webhook_secrets (id, created_at, organization_id, created_by, subscription_id, sealed, key_version)
         select ?, ?, organization_id, ?, id, ?, ? from webhook_subscriptions where id = ? and deleted_at is null${OWNER}`,
      )
      .bind(a.secretId, a.now, a.actorId, a.sealed, a.keyVersion, a.id, ...owner(a.ownerAgentId)),
    d1
      .prepare(
        `${AUDIT_INSERT} select ?, ?, ?, 'webhook.secret_rotated', 'webhook', subscription_id, json_object('secret_id', id) from webhook_secrets where id = ?`,
      )
      .bind(a.auditId, a.now, a.actorId, a.secretId),
  ])
  return (results[0]?.meta?.changes ?? 0) === 1 ? 'rotated' : 'not_found'
}

/** A live subscription by id; `ownerAgentId` (an agent caller's own id) hides another agent's. `null` for a missing or deleted one. */
export async function getWebhookSubscription(
  c: ControlDb,
  a: { id: string; ownerAgentId?: string },
): Promise<WebhookSubscriptionRecord | null> {
  const row = await raw(c)
    .prepare(`select ${WEBHOOK_COLUMNS} from webhook_subscriptions where id = ? and deleted_at is null${OWNER}`)
    .bind(a.id, ...owner(a.ownerAgentId))
    .first()
  return row ? webhookOf(row) : null
}

/** Live subscriptions in id order after the cursor; `ownerAgentId` limits an agent caller to its own, `agentId` is the optional filter. The caller asks for `limit + 1` to see whether a page follows. */
export async function listWebhookSubscriptions(
  c: ControlDb,
  a: { ownerAgentId?: string; agentId?: string; after?: string; limit: number },
): Promise<WebhookSubscriptionRecord[]> {
  const where = ['deleted_at is null']
  const binds: unknown[] = []
  if (a.ownerAgentId !== undefined) {
    where.push('agent_id = ?')
    binds.push(a.ownerAgentId)
  }
  if (a.agentId !== undefined) {
    where.push('agent_id = ?')
    binds.push(a.agentId)
  }
  if (a.after !== undefined) {
    where.push('id > ?')
    binds.push(a.after)
  }
  const res = await raw(c)
    .prepare(`select ${WEBHOOK_COLUMNS} from webhook_subscriptions where ${where.join(' and ')} order by id limit ?`)
    .bind(...binds, a.limit)
    .all()
  return ((res.results ?? []) as Array<Record<string, unknown>>).map(webhookOf)
}

const DELIVERY_COLUMNS =
  'id, subscription_id, event_id, event_type, status, attempts, next_attempt_at, last_attempt_at, last_status_code, last_error, delivered_at, created_at'

/**
 * A subscription's deliveries in id order (the order the dispatcher inserted them), no lease columns. `null` when the subscription is not visible to the caller (missing, deleted or another agent's),
 * judged as `getWebhookSubscription` judges it.
 */
export async function listWebhookDeliveries(
  c: ControlDb,
  a: { subscriptionId: string; ownerAgentId?: string; status?: WebhookDeliveryStatus; after?: string; limit: number },
): Promise<WebhookDeliveryRecord[] | null> {
  if (
    (await getWebhookSubscription(c, {
      id: a.subscriptionId,
      ...(a.ownerAgentId ? { ownerAgentId: a.ownerAgentId } : {}),
    })) === null
  )
    return null
  const where = ['subscription_id = ?']
  const binds: unknown[] = [a.subscriptionId]
  if (a.status !== undefined) {
    where.push('status = ?')
    binds.push(a.status)
  }
  if (a.after !== undefined) {
    where.push('id > ?')
    binds.push(a.after)
  }
  const res = await raw(c)
    .prepare(`select ${DELIVERY_COLUMNS} from webhook_deliveries where ${where.join(' and ')} order by id limit ?`)
    .bind(...binds, a.limit)
    .all()
  return ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    subscriptionId: r.subscription_id as string,
    eventId: r.event_id as string,
    eventType: r.event_type as string,
    status: r.status as WebhookDeliveryStatus,
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at as string,
    lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
    lastStatusCode: r.last_status_code === null || r.last_status_code === undefined ? null : Number(r.last_status_code),
    lastError: (r.last_error as string | null) ?? null,
    deliveredAt: (r.delivered_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }))
}

/**
 * The sealed secrets of the named subscriptions, oldest first (the sender's context read). With `inForceAt`, only those that sign at that instant ([[API7]] D12): the newest, plus the one before it
 * while the newest is under 24 hours old (the rotation overlap).
 */
export async function readWebhookSecrets(
  c: ControlDb,
  a: { subscriptionIds: string[]; inForceAt?: string },
): Promise<Array<{ subscriptionId: string; sealed: string; createdAt: string }>> {
  if (a.subscriptionIds.length === 0) return []
  const res = await raw(c)
    .prepare(
      'select subscription_id, sealed, created_at from webhook_secrets where subscription_id in (select value from json_each(?)) order by created_at, id',
    )
    .bind(JSON.stringify(a.subscriptionIds))
    .all()
  const all = ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    subscriptionId: r.subscription_id as string,
    sealed: r.sealed as string,
    createdAt: r.created_at as string,
  }))
  if (a.inForceAt === undefined) return all
  const now = Date.parse(a.inForceAt)
  const bySub = new Map<string, typeof all>()
  for (const r of all) bySub.set(r.subscriptionId, [...(bySub.get(r.subscriptionId) ?? []), r])
  const inForce = new Set<(typeof all)[number]>()
  for (const rowsOfSub of bySub.values()) {
    const newest = rowsOfSub[rowsOfSub.length - 1]!
    const previous = rowsOfSub[rowsOfSub.length - 2]
    inForce.add(newest)
    if (previous && now - Date.parse(newest.createdAt) < WEBHOOK_ROTATION_OVERLAP_MS) inForce.add(previous)
  }
  return all.filter((r) => inForce.has(r))
}

/**
 * The subscriptions to dispatch: active and live, of the agents the caller names (`eligibleAgentIds`: the CRM facts "live and not delegated", read by the caller, P4), with the position each was last
 * dispatched to. The agent's scopes are the caller's too.
 */
export async function listDispatchableWebhooks(
  c: ControlDb,
  a: { organizationId: string; eligibleAgentIds: string[] },
): Promise<WebhookDispatchTarget[]> {
  if (a.eligibleAgentIds.length === 0) return []
  const res = await raw(c)
    .prepare(
      `select s.id as id, s.created_by as created_by, s.agent_id as agent_id, s.event_types as event_types, st.cursor_event_id as cursor_event_id
       from webhook_subscriptions s join webhook_dispatch_state st on st.subscription_id = s.id and st.organization_id = s.organization_id
       where s.organization_id = ? and s.status = 'active' and s.deleted_at is null and s.agent_id in (select value from json_each(?))
       order by s.id`,
    )
    .bind(a.organizationId, JSON.stringify(a.eligibleAgentIds))
    .all()
  return ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    subscriptionId: r.id as string,
    createdBy: r.created_by as string,
    agentId: r.agent_id as string,
    eventTypes: JSON.parse(r.event_types as string) as string[],
    cursor: r.cursor_event_id as string,
  }))
}

/**
 * One page of the dispatcher (invariant 3): inserts the page's `pending` deliveries (`ON CONFLICT (subscription_id, event_id) DO NOTHING`) and moves the cursor to the page's last event, both only while
 * the state still holds `expectedCursor`, in one batch. A stale page (another tick moved the cursor) writes nothing: `moved: false`. An empty page writes nothing. Machinery: no audit row (P3).
 */
export async function applyWebhookDispatchPage(
  c: ControlDb,
  a: {
    organizationId: string
    subscriptionId: string
    createdBy: string
    expectedCursor: string
    events: Array<{ id: string; eventId: string; eventType: string }>
    now: string
  },
): Promise<{ moved: boolean }> {
  const last = a.events[a.events.length - 1]
  if (!last) return { moved: false }
  const d1 = raw(c)
  const atCursor = 'exists (select 1 from webhook_dispatch_state where subscription_id = ? and cursor_event_id = ?)'
  const results = await d1.batch([
    d1
      .prepare(
        `insert into webhook_deliveries (id, created_at, organization_id, created_by, subscription_id, event_id, event_type, status, attempts, next_attempt_at)
         select json_extract(value, '$.id'), ?, ?, ?, ?, json_extract(value, '$.event_id'), json_extract(value, '$.event_type'), 'pending', 0, ?
         from json_each(?) where ${atCursor}
         on conflict (subscription_id, event_id) do nothing`,
      )
      .bind(
        a.now,
        a.organizationId,
        a.createdBy,
        a.subscriptionId,
        a.now,
        JSON.stringify(a.events.map((e) => ({ id: e.id, event_id: e.eventId, event_type: e.eventType }))),
        a.subscriptionId,
        a.expectedCursor,
      ),
    d1
      .prepare(
        `update webhook_dispatch_state set cursor_event_id = ?, last_dispatched_at = ? where subscription_id = ? and organization_id = ? and cursor_event_id = ?`,
      )
      .bind(last.eventId, a.now, a.subscriptionId, a.organizationId, a.expectedCursor),
  ])
  return { moved: (results[1]?.meta?.changes ?? 0) === 1 }
}

/**
 * The claim of one sender wave: the due rows (a `pending` row due by `cutoff` whose lease is absent or lapsed at `now`, of a subscription that is active or deleted; a paused or disabled one is left alone),
 * at most `caps[subscription]` (else `defaultCap`) of each subscription and `limit` in all, then ONE batch that ends the spent ones (`attempts >= maxAttempts`) `dead` with `sender_failed` and leases the rest
 * (`attempts + 1`, `lease_until`, `lease_token`) with a guarded update. `rows` are the rows that really carry `token`, so a row another sender took between the read and the write is not ours; each carries the
 * subscription facts the sender needs (`url`, `deleted`, `agentId`) and nothing from the CRM: the agent's scopes and the event are the caller's reads (P4). No due row means no write.
 */
export async function claimWebhookDeliveries(
  c: ControlDb,
  a: {
    organizationId: string
    cutoff: string
    now: string
    limit: number
    caps: Record<string, number>
    defaultCap: number
    maxAttempts: number
    token: string
    leaseUntil: string
  },
): Promise<{ rows: WebhookDueDelivery[]; dead: number; totalDue: number }> {
  const d1 = raw(c)
  const res = await d1
    .prepare(
      `with due as (
         select d.id as id, d.subscription_id as subscription_id, d.event_id as event_id, d.attempts as attempts, d.next_attempt_at as next_attempt_at,
           row_number() over (partition by d.subscription_id order by d.next_attempt_at, d.id) as rn
         from webhook_deliveries d
         join webhook_subscriptions s on s.organization_id = d.organization_id and s.id = d.subscription_id
         where d.organization_id = ? and d.status = 'pending' and d.next_attempt_at <= ?
           and (d.lease_until is null or d.lease_until <= ?) and (s.status = 'active' or s.deleted_at is not null)
       )
       select due.id as id, due.subscription_id as subscription_id, due.event_id as event_id, due.attempts as attempts, s.url as url, s.deleted_at as deleted_at, s.agent_id as agent_id,
         count(*) over () as total_due
       from due
       join webhook_subscriptions s on s.organization_id = ? and s.id = due.subscription_id
       left join json_each(?) c on c.key = due.subscription_id
       where due.rn <= coalesce(c.value, ?)
       order by due.next_attempt_at, due.id
       limit ?`,
    )
    .bind(a.organizationId, a.cutoff, a.now, a.organizationId, JSON.stringify(a.caps), a.defaultCap, a.limit)
    .all()
  const found = ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    subscriptionId: r.subscription_id as string,
    eventId: r.event_id as string,
    attempts: Number(r.attempts),
    url: r.url as string,
    deleted: r.deleted_at !== null && r.deleted_at !== undefined,
    agentId: r.agent_id as string,
    totalDue: Number(r.total_due),
  }))
  const totalDue = found[0]?.totalDue ?? 0
  const spent = found.filter((r) => r.attempts >= a.maxAttempts).map((r) => r.id)
  const claim = found.filter((r) => r.attempts < a.maxAttempts).map((r) => r.id)
  const statements: D1PreparedLike[] = []
  if (spent.length > 0)
    statements.push(
      d1
        .prepare(
          `update webhook_deliveries set status = 'dead', last_error = 'sender_failed', lease_until = null, lease_token = null
           where organization_id = ? and id in (select value from json_each(?)) and status = 'pending' and attempts >= ?
             and (lease_until is null or lease_until <= ?)`,
        )
        .bind(a.organizationId, JSON.stringify(spent), a.maxAttempts, a.now),
    )
  if (claim.length > 0)
    statements.push(
      d1
        .prepare(
          `update webhook_deliveries set attempts = attempts + 1, lease_until = ?, lease_token = ?, last_attempt_at = ?
           where organization_id = ? and id in (select value from json_each(?)) and status = 'pending' and attempts < ?
             and next_attempt_at <= ? and (lease_until is null or lease_until <= ?)
             and exists (select 1 from webhook_subscriptions s where s.organization_id = webhook_deliveries.organization_id and s.id = webhook_deliveries.subscription_id and (s.status = 'active' or s.deleted_at is not null))`,
        )
        .bind(a.leaseUntil, a.token, a.now, a.organizationId, JSON.stringify(claim), a.maxAttempts, a.cutoff, a.now),
    )
  if (statements.length === 0) return { rows: [], dead: 0, totalDue }
  statements.push(
    d1
      .prepare(
        `select id, status, lease_token from webhook_deliveries where organization_id = ? and id in (select value from json_each(?)) and (lease_token = ? or status = 'dead')`,
      )
      .bind(a.organizationId, JSON.stringify(found.map((r) => r.id)), a.token),
  )
  const results = await d1.batch(statements)
  const outcome = (results[results.length - 1]?.results ?? []) as Array<Record<string, unknown>>
  const mine = new Set(outcome.filter((r) => r.lease_token === a.token).map((r) => r.id as string))
  return {
    rows: found.filter((r) => mine.has(r.id)).map(({ totalDue: _total, ...row }) => row),
    dead: outcome.filter((r) => r.status === 'dead').length,
    totalDue,
  }
}

/**
 * The record of a sender wave: ONE batch, one guarded update per outcome (`id` and `lease_token`), so a stale sender whose lease was taken over, or a second completion (the lease is cleared), changes nothing.
 * A delivered row also stamps `last_success_at` on its subscription's state. Returns, per outcome in order, whether it applied. Machinery: no audit row (P3).
 */
export async function recordWebhookDeliveries(
  c: ControlDb,
  a: { token: string; at: string; outcomes: WebhookDeliveryOutcome[] },
): Promise<boolean[]> {
  if (a.outcomes.length === 0) return []
  const d1 = raw(c)
  const statements: D1PreparedLike[] = []
  const index: number[] = []
  for (const o of a.outcomes) {
    index.push(statements.length)
    if (o.kind === 'delivered') {
      statements.push(
        d1
          .prepare(
            `update webhook_deliveries set status = 'delivered', delivered_at = ?, last_status_code = ?, last_error = null, lease_until = null, lease_token = null where id = ? and lease_token = ?`,
          )
          .bind(a.at, o.statusCode, o.id, a.token),
        d1
          .prepare(
            `update webhook_dispatch_state set last_success_at = ? where subscription_id = ?
               and exists (select 1 from webhook_deliveries where id = ? and status = 'delivered' and delivered_at = ?)`,
          )
          .bind(a.at, o.subscriptionId, o.id, a.at),
      )
    } else if (o.kind === 'failed') {
      statements.push(
        d1
          .prepare(
            `update webhook_deliveries set status = ?, last_error = ?, last_status_code = ?, next_attempt_at = coalesce(?, next_attempt_at), lease_until = null, lease_token = null where id = ? and lease_token = ?`,
          )
          .bind(o.dead ? 'dead' : 'pending', o.code, o.statusCode, o.nextAttemptAt, o.id, a.token),
      )
    } else {
      statements.push(
        d1
          .prepare(
            `update webhook_deliveries set status = 'cancelled', last_error = ?, lease_until = null, lease_token = null where id = ? and lease_token = ?`,
          )
          .bind(o.code, o.id, a.token),
      )
    }
  }
  const results = await d1.batch(statements)
  return index.map((i) => (results[i]?.meta?.changes ?? 0) === 1)
}
