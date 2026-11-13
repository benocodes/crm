// Test-only ([[CORE68]] C1). Builds valid `CaptureMessage`s and runs `recordMessages` on an engine. Used by the capture
// suites and by the contract fixtures of the six messaging resources (which seed through the program under construction
// of the unit they read, replacing the direct-insert seeding of cycle 1, P15).
import { sql } from 'kysely'
import { defineOperation, execute, step, unit, uuidv7, type PreparedOperation, type StorageBinding } from '@vibase/storage'
import { fileObjectPrefix } from '../messaging/r2-keys.js'
import { recordMessagesOperation, type CaptureAttachment, type CaptureInput, type CaptureMessage, type CaptureResult } from '../messaging/capture.js'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'
import type { Engine } from './engines.js'
import type { Tenant } from './tenant.js'

let counter = 0
const hex64 = (): string => (++counter).toString(16).padStart(64, '0')

export function storedAttachment(organizationId: string, position: number, opts: Partial<CaptureAttachment> & { sha256?: string; storage_key?: string } = {}): CaptureAttachment {
  const { sha256, storage_key, ...rest } = opts
  const sha = sha256 ?? hex64()
  const base: CaptureAttachment = {
    position,
    type: 'file',
    name: `file-${position}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 1000 + position,
    inline: false,
    content_id: null,
    fetch_status: 'stored',
    fetch_metadata: null,
    fetch_error: null,
    file: { storage_key: storage_key ?? fileObjectPrefix(organizationId, uuidv7()), sha256: sha, size_bytes: 1000 + position, name: `file-${position}.pdf`, mime_type: 'application/pdf' },
  }
  return { ...base, ...rest }
}

export type CaptureOverrides = Omit<Partial<CaptureMessage>, 'attachments'> & { attachments?: number | readonly CaptureAttachment[] }

/** A valid message: unique `external_id`, from `jane@acme.test` to `owner@vibase.test`, a fixed instant. `attachments: n` means n stored attachments. */
export function captureMessage(organizationId: string, over: CaptureOverrides = {}): CaptureMessage {
  const n = ++counter
  const { attachments, ...rest } = over
  const kind = rest.kind ?? 'message'
  return {
    channel: 'email',
    kind,
    external_id: `m-${n}@capture.test`,
    in_reply_to: null,
    thread_hints: [],
    provider_message_id: `pm-${n}`,
    provider_thread_id: `pt-${n}`,
    occurred_at: '2026-10-22T09:00:00.000Z',
    subject: `Subject ${n}`,
    author: { user_id: 'jane@acme.test', user_name: 'jane@acme.test', full_name: 'Jane', is_bot: false },
    preview: `Preview ${n}`,
    content_key: kind === 'message' ? `orgs/${organizationId.toLowerCase()}/messages/email/${hex64()}` : null,
    sent_by_connection: false,
    participants: [
      { kind: 'email', value: 'jane@acme.test', role: 'from' },
      { kind: 'email', value: 'owner@vibase.test', role: 'to' },
    ],
    attachments: typeof attachments === 'number' ? Array.from({ length: attachments }, (_, i) => storedAttachment(organizationId, i)) : (attachments ?? []),
    ...rest,
  }
}

/**
 * CHN140 D27: a source row's `connection_id` is a foreign key to `channel_connections` on D1, so a capture needs its connection to exist. This is
 * the test device that makes one (a connection owned by `ownerId` and the own identity it must name, both with the connection's id; the identity is deleted, so no
 * live read, list or participant sees it; nothing is written when the connection exists):
 * not an operation, and the connect flow's own writes are proven by the CHN140 suites. Postgres has no such table (D1 only): a no-op there.
 */
export function ensureConnectionOperation(organizationId: string, ownerId: string, connectionId: string): PreparedOperation<void> {
  const at = '2026-10-22T08:00:00.000Z'
  return defineOperation<void>({
    name: 'test.ensure_connection',
    mutates: true,
    reads: () => ({}),
    build: (_found, qc) =>
      unit({
        steps: [
          step(
            sql`insert into "identities" ("id", "created_at", "updated_at", "organization_id", "created_by", "kind", "value", "contact_id", "own", "deleted_at")
              select ${connectionId}, ${at}, ${at}, ${organizationId}, ${ownerId}, 'email', ${`conn-${connectionId}@seed.test`}, null, 1, ${at}
              where not exists (select 1 from "channel_connections" where "id" = ${connectionId}) on conflict do nothing`.compile(qc.db),
          ),
          step(
            sql`insert into "channel_connections" ("id", "created_at", "updated_at", "organization_id", "created_by", "provider", "account_id", "identity_id", "owner_id", "status", "granted_scopes", "connected_at")
              values (${connectionId}, ${at}, ${at}, ${organizationId}, ${ownerId}, 'google', ${`seed-${connectionId}`}, ${connectionId}, ${ownerId}, 'active', '[]', ${at}) on conflict do nothing`.compile(qc.db),
          ),
        ],
        events: [],
        decode: () => undefined,
      }),
  })
}

const ensured = new WeakMap<StorageBinding, Set<string>>()
/** A harness that empties the database but keeps its binding (the golden backend) calls this on reset, so the next capture makes its connection again. */
export const forgetEnsuredConnections = (binding: StorageBinding): void => void ensured.delete(binding)
/**
 * Makes `connectionId` exist on a D1 binding (see `ensureConnectionOperation`); a no-op on another engine. Remembered per binding (a reset makes a
 * new one), so a connection is made once: a later call touches nothing, which keeps the "between plan and commit" drift hook of the engine for the unit
 * under test. A suite that arms that hook seeds every connection it uses first.
 */
export async function ensureConnection(binding: StorageBinding, t: { organizationId: string; userId: string }, connectionId: string): Promise<void> {
  if (binding.kind !== 'd1') return
  const done = ensured.get(binding) ?? new Set<string>()
  ensured.set(binding, done)
  if (done.has(connectionId)) return
  done.add(connectionId)
  await execute(binding, { kind: 'tenant', actorId: t.userId, organizationId: t.organizationId }, ensureConnectionOperation(t.organizationId, t.userId, connectionId))
}

/** Runs one capture unit on the engine as the tenant's user (or agent). */
export async function runCapture(engine: Engine, input: CaptureInput, as: 'user' | 'agent' = 'user') {
  await ensureConnection(engine.binding, engine, input.connection_id)
  return engine.run(recordMessagesOperation(engine.env({ as }), input), as)
}

/** The unit environment of a contract tenant's user: injected clock and ids, as `Engine.env` builds for the storage suites. */
export function tenantEnv(t: Tenant, now = new Date('2026-10-22T10:00:00.000Z')): PreparedEnv {
  return {
    actor: { id: t.userId, kind: 'user' },
    organizationId: t.organizationId,
    scopes: ScopeSet.parse([]),
    now,
    newId: () => uuidv7(now),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  }
}

/** Runs one capture unit as the tenant's user on a contract session's binding. */
export async function captureAs(binding: StorageBinding, t: Tenant, input: CaptureInput): Promise<CaptureResult> {
  await ensureConnection(binding, t, input.connection_id)
  const out = await execute(binding, { kind: 'tenant', actorId: t.userId, organizationId: t.organizationId }, recordMessagesOperation(tenantEnv(t), input))
  return out.value
}

export type { CaptureResult }
