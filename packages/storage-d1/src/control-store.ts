// The control store ([[CORE259]] D5): the ONE module below composition that holds the control-plane database. `ControlDb` is an opaque handle, deliberately not a `D1Like`:
// the storage runtime (`d1Binding`) and everything the operations, the registry and any SQL or DDL path receive wrap the CRM database only, and the type system refuses
// the control handle there. Composition opens the handle from `CONTROL_DB` and hands it to the auth provider (`controlAuthDatabase`) and to this module's few functions.
// The surface is the marker ([[CORE259]] D7) and the tracker read; the control-plane resources and the audit log arrive with [[CORE261]].
import type { D1Like, D1PreparedLike } from './binding.js'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { readMigrationState, type MigrationState } from './migration-state.js'

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
  await raw(c).prepare('insert into control_deployment (singleton, organization_id) values (1, ?) on conflict do nothing').bind(organizationId).run()
  const now = await readControlMarker(c)
  if (!now || now.organizationId !== organizationId) throw conflict(now?.organizationId ?? 'unknown')
  return 'created'
}

/** The tracker against this build's control manifest ([[CORE259]] D4): the same comparison as the CRM database's ([[CORE61]]). */
export function readControlMigrations(c: ControlDb): Promise<MigrationState> {
  return readMigrationState(raw(c), CONTROL_MIGRATIONS.map((m) => m.name))
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
  return ((res.results ?? []) as Array<{ id: string; alg: string | null; public_key: string }>).map((r) => ({ kid: r.id, alg: r.alg ?? 'EdDSA', publicJwk: r.public_key }))
}

/** The Better Auth account behind a token's subject ([[CORE244]] D9): what first sight of a delegated agent's human needs. `null` when no such account. */
export async function readAuthProfile(c: ControlDb, userId: string): Promise<{ email: string; emailVerified: boolean; name: string } | null> {
  const row = await raw(c).prepare('select email, email_verified, name from auth_users where id = ?').bind(userId).first()
  return row ? { email: row.email as string, emailVerified: Number(row.email_verified) === 1, name: row.name as string } : null
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
}
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
  /** The unit's clock: `created_at`, the audit `at`, and what "live" is judged against. */
  now: string
}

const COLUMNS = 'id, organization_id, email, role, expires_at, created_by, created_at, accepted_at, revoked_at'
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
})
/** An invitation is live while it is not accepted, not revoked and `expires_at` is after `now` (ISO text compares as time). */
const LIVE = 'accepted_at is null and revoked_at is null and expires_at > ?'

/** The `control_audit` insert for an invitation change, written only when the invitation row is in the state the change leaves it in (`guard`, a SQL condition on the same `id`). */
const auditStatement = (d1: D1Like, a: { auditId: string; now: string; actorId: string; action: string; invitationId: string; guard: string; guardBinds: unknown[] }) =>
  d1
    .prepare(
      `insert into control_audit (id, at, actor_id, action, target_type, target_id, detail)
       select ?, ?, ?, ?, 'invitation', id, json_object('email', email, 'role', role, 'expires_at', expires_at)
       from invitations where id = ? and ${a.guard}`,
    )
    .bind(a.auditId, a.now, a.actorId, a.action, a.invitationId, ...a.guardBinds)

const insertStatements = (d1: D1Like, a: NewInvitation): D1PreparedLike[] => [
  // Guarded insert: nothing is written when another live invitation holds the address (the one-live-per-email rule, judged in the same statement that writes).
  d1
    .prepare(
      `insert into invitations (id, organization_id, email, role, expires_at, created_by, created_at, accepted_at, revoked_at, token_hash)
       select ?, ?, ?, ?, ?, ?, ?, null, null, ?
       where not exists (select 1 from invitations where email = ? and ${LIVE})`,
    )
    .bind(a.id, a.organizationId, a.email, a.role, a.expiresAt, a.createdBy, a.now, a.tokenHash, a.email, a.now),
  auditStatement(d1, { auditId: a.auditId, now: a.now, actorId: a.createdBy, action: 'invitation.created', invitationId: a.id, guard: '1 = 1', guardBinds: [] }),
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

const readInvitation = async (d1: D1Like, id: string): Promise<InvitationRecord | null> => {
  const row = await d1.prepare(`select ${COLUMNS} from invitations where id = ?`).bind(id).first()
  return row ? recordOf(row) : null
}

/**
 * Revokes a live invitation and writes its `invitation.revoked` audit row in one batch. `not_live` (nothing written) for one that is accepted, revoked or expired, with the
 * record as it is; `not_found` for an unknown id.
 */
export async function revokeInvitation(c: ControlDb, a: { id: string; auditId: string; actorId: string; now: string }): Promise<{ result: 'revoked' | 'not_live'; record: InvitationRecord } | { result: 'not_found' }> {
  const d1 = raw(c)
  const results = await d1.batch([
    d1.prepare(`update invitations set revoked_at = ? where id = ? and ${LIVE}`).bind(a.now, a.id, a.now),
    auditStatement(d1, { auditId: a.auditId, now: a.now, actorId: a.actorId, action: 'invitation.revoked', invitationId: a.id, guard: 'revoked_at = ?', guardBinds: [a.now] }),
  ])
  const record = await readInvitation(d1, a.id)
  if (!record) return { result: 'not_found' }
  return { result: (results[0]?.meta?.changes ?? 0) === 1 ? 'revoked' : 'not_live', record }
}

/**
 * Bootstrap's owner invitation ([[CORE245]] P7), when no owner exists: every live OWNER invitation is revoked and a fresh one is created in ONE batch, each change with its audit row. The
 * lost-link recovery before `owner-reset`. A live invitation of another role for the same address refuses it (`live_exists`) before anything is revoked.
 */
export async function reissueOwnerInvitation(c: ControlDb, a: NewInvitation & { newAuditId: () => string }): Promise<{ result: 'created'; revoked: string[] } | { result: 'live_exists' }> {
  const d1 = raw(c)
  const owners = ((await d1.prepare(`select id, email from invitations where role = 'owner' and ${LIVE}`).bind(a.now).all()).results ?? []) as Array<{ id: string; email: string }>
  const blocking = await d1.prepare(`select id from invitations where email = ? and role <> 'owner' and ${LIVE}`).bind(a.email, a.now).first()
  if (blocking) return { result: 'live_exists' }
  const revoke = owners.flatMap((o) => [
    d1.prepare(`update invitations set revoked_at = ? where id = ? and ${LIVE}`).bind(a.now, o.id, a.now),
    auditStatement(d1, { auditId: a.newAuditId(), now: a.now, actorId: a.createdBy, action: 'invitation.revoked', invitationId: o.id, guard: 'revoked_at = ?', guardBinds: [a.now] }),
  ])
  const results = await d1.batch([...revoke, ...insertStatements(d1, a)])
  if ((results[revoke.length]?.meta?.changes ?? 0) !== 1) return { result: 'live_exists' }
  return { result: 'created', revoked: owners.map((o) => o.id) }
}
