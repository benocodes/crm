// The first-party OAuth client store ([[CORE623]] D4, D5, D6, D9): create, list, get, update and delete over `auth_oauth_clients` and `auth_oauth_client_resources`, with hand-written SQL in the encodings
// Better Auth itself writes (JSON arrays as text, booleans as 0/1, ISO-8601 text), proven against the real library's authorize, token and refresh. Every change is ONE control batch with its
// `oauth_client.*` `control_audit` row ([[CORE259]] D12), and a guarded change that matches no first-party row writes nothing, audit row included.
//
// A client is first-party when its `reference_id` is the organisation id the caller passes: create writes it, `user_id` stays null (so the repair sweep, which deletes unreferenced clients of an
// unauthenticated registration, and an owner leaving, which cascades their own clients, never reach it), and every other method reads and changes only rows with that `reference_id`. The store
// validates none of the operations' input rules (D7): it trusts its caller, as the other control-store writers do.
import type { D1Like, D1PreparedLike } from './binding.js'
import { raw, type ControlDb } from './control-store.js'

export interface OAuthClientRecord {
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string[]
  skipConsent: boolean
  createdAt: string
  updatedAt: string
}

export interface NewOAuthClient {
  /** Written to `reference_id`: what makes the client first-party. */
  organizationId: string
  /** Supplied by the caller (the operation generates it, [[CORE623]] P1). */
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string[]
  skipConsent: boolean
  /** The resource identifiers the client is linked to (`resourcesFor(PUBLIC_BASE_URL)`); resource rows are created when absent, as the seed does. */
  resources: readonly string[]
  /** The audit row's `actor_id` (a 36-character id). */
  actorId: string
  /** ISO-8601; the client's own timestamps are stored to the whole second, as Better Auth stores a registered client's creation time. */
  now: string
  /** Row ids (client, links, resources, audit): UUIDs. */
  newId: () => string
}

export interface OAuthClientChange {
  organizationId: string
  clientId: string
  actorId: string
  now: string
  newId: () => string
  /** Any subset of the four owner fields; a list replaces whole. */
  name?: string
  redirectUris?: string[]
  scopes?: string[]
  skipConsent?: boolean
}

const COLUMNS = 'client_id, name, redirect_uris, scopes, skip_consent, created_at, updated_at'
const toRecord = (r: Record<string, unknown>): OAuthClientRecord => ({
  clientId: r.client_id as string,
  name: (r.name as string | null) ?? '',
  redirectUris: JSON.parse((r.redirect_uris as string | null) ?? '[]') as string[],
  scopes: JSON.parse((r.scopes as string | null) ?? '[]') as string[],
  skipConsent: Number(r.skip_consent) === 1,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
})
/** Better Auth writes a registered client's `created_at` to the second; so does the store (the sweep's seven-day comparison and the list order rely on one form). */
const wholeSecond = (iso: string): string => new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString()

/** The audit detail: the owner fields as stored, `skip_consent` as a JSON boolean. */
const DETAIL = `json_object('name', name, 'redirect_uris', json(redirect_uris), 'scopes', json(scopes), 'skip_consent', json(case when skip_consent = 1 then 'true' else 'false' end))`
const auditInsert = (
  d1: D1Like,
  a: { auditId: string; at: string; actorId: string; action: string; from: string },
  ...binds: unknown[]
): D1PreparedLike =>
  d1
    .prepare(
      `insert into control_audit (id, at, actor_id, action, target_type, target_id, detail)
       select ?, ?, ?, ?, 'oauth_client', client_id, ${DETAIL} from auth_oauth_clients where ${a.from}`,
    )
    .bind(a.auditId, a.at, a.actorId, a.action, ...binds)

const read = async (d1: D1Like, organizationId: string, clientId: string): Promise<OAuthClientRecord | null> => {
  const row = await d1
    .prepare(`select ${COLUMNS} from auth_oauth_clients where client_id = ? and reference_id = ?`)
    .bind(clientId, organizationId)
    .first()
  return row ? toRecord(row as Record<string, unknown>) : null
}

/** Creates a first-party client, its resource links and its `oauth_client.created` audit row in one batch; `exists` (nothing written but absent resource rows) when the client id is taken. */
export async function createOAuthClient(c: ControlDb, a: NewOAuthClient): Promise<OAuthClientRecord | 'exists'> {
  const d1 = raw(c)
  const at = wholeSecond(a.now)
  const rowId = a.newId()
  const statements: D1PreparedLike[] = a.resources.map((identifier) =>
    d1
      .prepare(
        `insert into auth_oauth_resources (id, identifier, name, custom_claims, dpop_bound_access_tokens_required, disabled, created_at, updated_at, policy_version, metadata)
         select ?, ?, ?, 'null', 0, 0, ?, ?, 1, 'null' where not exists (select 1 from auth_oauth_resources where identifier = ?)`,
      )
      .bind(a.newId(), identifier, identifier, a.now, a.now, identifier),
  )
  const clientAt = statements.length
  statements.push(
    d1
      .prepare(
        `insert into auth_oauth_clients (id, client_id, client_secret, disabled, skip_consent, scopes, client_credentials_scopes, user_id, created_at, updated_at, name, redirect_uris,
           token_endpoint_auth_method, application_type, grant_types, response_types, require_pkce, dpop_bound_access_tokens, reference_id)
         select ?, ?, null, 0, ?, ?, '[]', null, ?, ?, ?, ?, 'none', 'web', '["authorization_code","refresh_token"]', '["code"]', 1, 0, ?
         where not exists (select 1 from auth_oauth_clients where client_id = ?)`,
      )
      .bind(
        rowId,
        a.clientId,
        a.skipConsent ? 1 : 0,
        JSON.stringify(a.scopes),
        at,
        at,
        a.name,
        JSON.stringify(a.redirectUris),
        a.organizationId,
        a.clientId,
      ),
    ...a.resources.map((identifier) =>
      d1
        .prepare(
          `insert into auth_oauth_client_resources (id, client_id, resource_id, created_at)
           select ?, ?, ?, ? where exists (select 1 from auth_oauth_clients where id = ?)`,
        )
        .bind(a.newId(), a.clientId, identifier, at, rowId),
    ),
    auditInsert(
      d1,
      { auditId: a.newId(), at: a.now, actorId: a.actorId, action: 'oauth_client.created', from: 'id = ?' },
      rowId,
    ),
  )
  const results = await d1.batch(statements)
  if ((results[clientAt]?.meta?.changes ?? 0) !== 1) return 'exists'
  return (await read(d1, a.organizationId, a.clientId))!
}

/** Every first-party client of the organisation, oldest first, ties by client id. */
export async function listOAuthClients(c: ControlDb, a: { organizationId: string }): Promise<OAuthClientRecord[]> {
  const rows = await raw(c)
    .prepare(`select ${COLUMNS} from auth_oauth_clients where reference_id = ? order by created_at, client_id`)
    .bind(a.organizationId)
    .all()
  return ((rows.results ?? []) as Array<Record<string, unknown>>).map(toRecord)
}

/** One first-party client of the organisation; `null` for any other row (a registered client, the CLI client, another organisation's) and for an unknown id. */
export async function getOAuthClient(
  c: ControlDb,
  a: { organizationId: string; clientId: string },
): Promise<OAuthClientRecord | null> {
  return read(raw(c), a.organizationId, a.clientId)
}

/**
 * Edits any subset of the four owner fields of a first-party client and writes `oauth_client.updated` (the state after) in one batch; `updated_at` moves to the whole second of `now`. `null`, nothing
 * written, when no first-party client of the organisation has the id. An empty change writes nothing (no audit row either) and answers the current record: refusing it is the operation's.
 */
export async function updateOAuthClient(c: ControlDb, a: OAuthClientChange): Promise<OAuthClientRecord | null> {
  const d1 = raw(c)
  const sets: string[] = []
  const binds: unknown[] = []
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`)
    binds.push(value)
  }
  if (a.name !== undefined) set('name', a.name)
  if (a.redirectUris !== undefined) set('redirect_uris', JSON.stringify(a.redirectUris))
  if (a.scopes !== undefined) set('scopes', JSON.stringify(a.scopes))
  if (a.skipConsent !== undefined) set('skip_consent', a.skipConsent ? 1 : 0)
  if (sets.length === 0) return read(d1, a.organizationId, a.clientId)
  set('updated_at', wholeSecond(a.now))
  const results = await d1.batch([
    d1
      .prepare(`update auth_oauth_clients set ${sets.join(', ')} where client_id = ? and reference_id = ?`)
      .bind(...binds, a.clientId, a.organizationId),
    auditInsert(
      d1,
      {
        auditId: a.newId(),
        at: a.now,
        actorId: a.actorId,
        action: 'oauth_client.updated',
        from: 'client_id = ? and reference_id = ? and changes() = 1',
      },
      a.clientId,
      a.organizationId,
    ),
  ])
  if ((results[0]?.meta?.changes ?? 0) !== 1) return null
  return read(d1, a.organizationId, a.clientId)
}

/**
 * Deletes a first-party client with its `oauth_client.deleted` audit row (the state before) in one batch: the audit insert runs first, conditioned on the row, then the delete; the foreign keys cascade the
 * client's access and refresh tokens, consents and resource links ([[CORE623]] D9). `false`, nothing written, when no first-party client of the organisation has the id.
 */
export async function deleteOAuthClient(
  c: ControlDb,
  a: { organizationId: string; clientId: string; actorId: string; now: string; newId: () => string },
): Promise<boolean> {
  const d1 = raw(c)
  const results = await d1.batch([
    auditInsert(
      d1,
      {
        auditId: a.newId(),
        at: a.now,
        actorId: a.actorId,
        action: 'oauth_client.deleted',
        from: 'client_id = ? and reference_id = ?',
      },
      a.clientId,
      a.organizationId,
    ),
    d1
      .prepare('delete from auth_oauth_clients where client_id = ? and reference_id = ?')
      .bind(a.clientId, a.organizationId),
  ])
  return (results[0]?.meta?.changes ?? 0) === 1
}
