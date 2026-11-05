// The connect unit ([[CHN5]] D9, D10, D26, D31, D55, D56): everything the OAuth callback writes, as ONE prepared unit acting as the user.
// On D1 a unit is one batch, so the connection, its credential, its cursor, its sync-state row, the own identities and every event
// exist together or not at all. Composition: each address runs [[CORE2]]'s `ensureOwnProgram` (its statements and events), then the
// connection statement (insert, or the reconnect update, stamp-guarded), then the machinery rows. Assertions abort the whole batch as
// drift when an expected event is missing, so a stale plan never leaves half a connect behind.
import { sql, type SqlBool } from 'kysely'
import { Found, UnitDriftError, assertStep, codecs, defineOperation, readMaybe, step, ts, unit, type EventReceipt, type PreparedOperation, type Row, type Step } from '@vault/storage'
import { eventStatement } from '../outbox.js'
import { ensureOwnProgram } from '../identity/resolve.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import { connections } from '../resources/connections.js'
import { afterOf, selectRecord, toRecord } from '../storage/crud.js'
import type { PreparedEnv } from '../storage/definition.js'

export interface ConnectInput {
  /** The Google account's stable id (the ID token's `sub`). */
  google_sub: string
  /** The profile's address: the connection's own identity. Must be one of `own_addresses`. */
  mailbox: string
  /** The addresses that become own: the profile address and each verified send-as address. */
  own_addresses: readonly string[]
  /** The scopes Google says were granted. */
  granted_scopes: readonly string[]
  /** `sealToken`'s output for the refresh token. */
  ciphertext: string
  key_version: number
  /** The profile's history id: the cursor a new connection starts from (a reconnect keeps its own). */
  history_id: string
}
export interface ConnectResult {
  connection_id: string
  created: boolean
}

const EXISTING = 'connect:existing'
const sub = (i: number, key: string): string => `connect:a${i}:${key}`
const bare = (s: Step): Step => ({ query: s.query, ...(s.expect ? { expect: s.expect } : {}) })
const eventExists = (id: string) => sql<SqlBool>`exists (select 1 from "events" where "events"."id" = ${id})`

export function connectOperation(env: PreparedEnv, input: ConnectInput): PreparedOperation<ConnectResult> {
  const mailbox = normalizeIdentityValue('email', input.mailbox)
  const addresses = [...new Set(input.own_addresses.map((a) => normalizeIdentityValue('email', a)))]
  if (!addresses.includes(mailbox)) throw new Error('the mailbox must be one of the own addresses')
  const programs = addresses.map((value) => ensureOwnProgram(env, { kind: 'email', value }))
  const org = env.organizationId
  const actor = env.actor.id
  const at = codecs.timestamp.write(env.now)
  const newConnectionId = env.newId()
  const credentialId = env.newId()
  const eventId = env.newId()
  const scopes = [...input.granted_scopes]
  const identityOfMailbox = sql<string>`(select "identities"."id" from "identities" where "identities"."organization_id" = ${org} and "identities"."kind" = 'email' and "identities"."value" = ${mailbox} and "identities"."deleted_at" is null)`

  return defineOperation<ConnectResult>({
    name: 'connections.connect',
    mutates: true,
    reads: (qc) => ({
      [EXISTING]: readMaybe(
        selectRecord(connections, qc, env, undefined, { derived: false })
          .where(sql<SqlBool>`${sql.ref('channel_connections.provider')} = 'google'`)
          .where(sql<SqlBool>`${sql.ref('channel_connections.account_id')} = ${input.google_sub}`)
          .select(ts.exact(qc, 'channel_connections.updated_at').as('__stamp')),
      ),
      ...Object.assign({}, ...programs.map((p, i) => Object.fromEntries(Object.entries(p.reads(qc)).map(([k, v]) => [sub(i, k), v])))),
    }),
    build: (found, qc) => {
      const row = found.maybe(EXISTING)
      const steps: Step[] = []
      const events: EventReceipt[] = []
      // 1. The own identities: each program's statements and events, in address order; its result select is not ours.
      programs.forEach((p, i) => {
        const reads = Object.fromEntries(Object.keys(p.reads(qc)).map((k) => [k, found.all(sub(i, k))]))
        const built = p.build(Found.ofRows(reads), qc)
        steps.push(...built.steps.filter((s) => s.label !== 'result').map(bare))
        for (const e of built.events) {
          events.push(e)
          // A stale plan (the identity changed since the read) skips its event: abort the whole unit as drift rather than connect without it.
          steps.push(assertStep(qc, eventExists(e.id)))
        }
      })
      // 2. The connection: a new row, or the live row of the same Google account updated (D31, D56).
      let existingId: string | null = null
      if (!row) {
        steps.push(
          step(
            qc.db.insertInto('channel_connections').values({
              id: newConnectionId,
              created_at: at,
              updated_at: at,
              organization_id: org,
              created_by: actor,
              provider: 'google',
              account_id: input.google_sub,
              identity_id: identityOfMailbox as never,
              owner_id: actor,
              status: 'active',
              granted_scopes: scopes,
              connected_at: at,
            }),
            'first-mutation',
          ),
          step(eventStatement(qc, { id: eventId, at, organizationId: org, actorId: actor, type: 'connection.created', resourceType: 'connection', resourceId: newConnectionId, before: null, after: afterOf(connections) }), 'first-event'),
        )
      } else {
        const { __stamp, ...rest } = row as Record<string, unknown>
        const before = toRecord(connections, rest as Row)
        existingId = before.id
        steps.push(
          step(
            qc.db
              .updateTable('channel_connections')
              .set({ owner_id: actor, status: 'active', granted_scopes: scopes, connected_at: at, updated_at: at, identity_id: identityOfMailbox as never })
              .where('channel_connections.id', '=', before.id)
              .where('channel_connections.organization_id', '=', org)
              .where('channel_connections.deleted_at', 'is', null)
              .where(sql<SqlBool>`${ts.exact(qc, 'channel_connections.updated_at')} = ${String(__stamp)}`),
            'first-mutation',
            { expect: 'affected' },
          ),
          step(eventStatement(qc, { id: eventId, at, organizationId: org, actorId: actor, type: 'connection.updated', resourceType: 'connection', resourceId: before.id, before, after: afterOf(connections) }), 'first-event'),
        )
      }
      const id = existingId ?? newConnectionId
      events.push({ id: eventId, type: existingId ? 'connection.updated' : 'connection.created', resourceType: 'connection', resourceId: id })
      steps.push(assertStep(qc, eventExists(eventId)))
      // 3. The machinery (D26): the credential (insert-only; a live reconnect replaces the older rows), the cursor (kept on a reconnect: a new
      //    history id would open a gap), and the sync state (an old error is cleared on a reconnect).
      steps.push(bare(step(qc.db.insertInto('channel_credentials').values({ id: credentialId, organization_id: org, created_by: actor, created_at: at, connection_id: id, refresh_token_ciphertext: input.ciphertext, key_version: input.key_version }))))
      if (existingId) steps.push(bare(step(qc.db.deleteFrom('channel_credentials').where('connection_id', '=', id).where('organization_id', '=', org).where('id', '!=', credentialId))))
      steps.push(
        bare(step(qc.db.insertInto('mail_sync_cursors').values({ connection_id: id, organization_id: org, created_by: actor, created_at: at, history_id: input.history_id, page_token: null, last_synced_at: null }).onConflict((oc) => oc.column('connection_id').doNothing()))),
        bare(step(qc.db.insertInto('mail_sync_state').values({ connection_id: id, organization_id: org, created_by: actor, created_at: at }).onConflict((oc) => oc.column('connection_id').doNothing()))),
      )
      if (existingId) steps.push(bare(step(qc.db.updateTable('mail_sync_state').set({ last_error_code: null, last_error_at: null }).where('connection_id', '=', id).where('organization_id', '=', org))))
      // 4. The result: the connection, proven by its event.
      steps.push(step(qc.db.selectFrom('channel_connections').select('channel_connections.id').where('channel_connections.id', '=', id).where(eventExists(eventId)), 'result'))
      return unit({
        steps,
        events,
        decode: (rows) => {
          if (rows.length === 0) throw new UnitDriftError('connections.connect')
          return { connection_id: id, created: existingId === null }
        },
      })
    },
  })
}
