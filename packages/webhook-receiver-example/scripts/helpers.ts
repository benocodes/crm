// Shared by the example's tests: signing as the vault does, the event record a delivery carries, and a fake Workflow binding.
import { signatureHeader } from '@vibase/api'
import { IDS } from './fake-vault.js'
import type { WorkflowBinding } from '../src/receiver.js'

/** A fixed secret in the vault's `whsec_<base64 of 32 bytes>` shape. */
export const SECRET = 'whsec_' + Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
export const OTHER_SECRET = 'whsec_' + Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
export const EVENT_ID = '0192f4a0-0000-7000-a000-0000000000e1'
export const NOW_MS = Date.UTC(2026, 10, 12, 12, 0, 0)

export function eventRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    organization_id: '0192f4a0-0000-7000-a000-0000000000a1',
    type: 'interaction.created',
    resource_type: 'interaction',
    resource_id: IDS.interaction,
    actor_id: IDS.agent,
    before: null,
    after: { id: IDS.interaction, direction: 'inbound', thread_id: IDS.thread, message_id: IDS.message },
    created_at: new Date(NOW_MS).toISOString(),
    ...overrides,
  }
}

/** Signed with the vault's own signing code: the receiver is tested against the sender's side, not a copy of it. */
export async function signedRequest(a: { body?: string; secrets?: string[]; id?: string; timestamp?: number; method?: string; omit?: string[]; headers?: Record<string, string> } = {}): Promise<Request> {
  const body = a.body ?? JSON.stringify(eventRecord())
  const id = a.id ?? EVENT_ID
  const timestamp = a.timestamp ?? Math.floor(NOW_MS / 1000)
  const signature = await signatureHeader({ secrets: a.secrets ?? [SECRET], id, timestamp, body })
  const headers: Record<string, string> = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature, ...a.headers }
  for (const h of a.omit ?? []) delete headers[h]
  return new Request('http://receiver.test/hook', { method: a.method ?? 'POST', headers, ...((a.method ?? 'POST') === 'GET' ? {} : { body }) })
}

/** Keeps instances by id like the platform: a second `create` with a used id throws. */
export class FakeWorkflow implements WorkflowBinding {
  instances = new Map<string, unknown>()
  creates: Array<{ id: string; params: unknown }> = []
  failWith: Error | null = null
  async create(options: { id: string; params: unknown }) {
    this.creates.push(options)
    if (this.failWith) throw this.failWith
    if (this.instances.has(options.id)) throw new Error('instance.already_exists')
    this.instances.set(options.id, options.params)
    return { id: options.id }
  }
  async get(id: string) {
    if (!this.instances.has(id)) throw new Error('instance.not_found')
    return { id }
  }
}
