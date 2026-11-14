// The control store ([[CORE259]] D5): the ONE module below composition that holds the control-plane database. `ControlDb` is an opaque handle, deliberately not a `D1Like`:
// the storage runtime (`d1Binding`) and everything the operations, the registry and any SQL or DDL path receive wrap the CRM database only, and the type system refuses
// the control handle there. Composition opens the handle from `CONTROL_DB` and hands it to the auth provider (`controlAuthDatabase`) and to this module's few functions.
// The surface is the marker ([[CORE259]] D7) and the tracker read; the control-plane resources and the audit log arrive with [[CORE261]].
import type { D1Like } from './binding.js'
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
