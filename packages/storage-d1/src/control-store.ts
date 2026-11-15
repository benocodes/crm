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
  _c: ControlDb,
  _a: { after?: string; limit: number; action?: string; targetType?: string; targetId?: string },
): Promise<ControlAuditRecord[]> {
  throw new Error('not implemented')
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
      guard: 'revoked_at = ?',
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
      guard: 'accepted_at = ?',
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
