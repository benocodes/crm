// Test-only ([[CORE68]] C1). Builds valid `CaptureMessage`s and runs `recordMessages` on an engine. Used by the capture
// suites and by the contract fixtures of the six messaging resources (which seed through the program under construction
// of the unit they read, replacing the direct-insert seeding of cycle 1, P15).
import { execute, uuidv7, type StorageBinding } from '@vault/storage'
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

/** A valid message: unique `external_id`, from `jane@acme.test` to `owner@vault.test`, a fixed instant. `attachments: n` means n stored attachments. */
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
      { kind: 'email', value: 'owner@vault.test', role: 'to' },
    ],
    attachments: typeof attachments === 'number' ? Array.from({ length: attachments }, (_, i) => storedAttachment(organizationId, i)) : (attachments ?? []),
    ...rest,
  }
}

/** Runs one capture unit on the engine as the tenant's user (or agent). */
export function runCapture(engine: Engine, input: CaptureInput, as: 'user' | 'agent' = 'user') {
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
  const out = await execute(binding, { kind: 'tenant', actorId: t.userId, organizationId: t.organizationId }, recordMessagesOperation(tenantEnv(t), input))
  return out.value
}

export type { CaptureResult }
