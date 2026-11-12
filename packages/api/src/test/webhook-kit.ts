// Test-only: never import from non-test code. The webhook suites' harness ([[API7]]): the D1 engine, a registry with the webhook configuration injected, the app with
// an injected clock, a caller that is the owner (a user) or an agent with explicit token scopes, and raw readers of the three webhook tables.
import { uuidv7 } from '@vault/storage'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import type { WebhooksRuntime } from '../webhooks/config.js'
import { openD1Engine, type Engine } from './engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

export const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
export const KEY_B64 = Buffer.from(KEY_BYTES).toString('base64')
export const NOW = new Date('2026-11-12T10:00:00.000Z')
export const OWNER_SCOPES = ['webhooks:read', 'webhooks:write', 'events:read', 'schema:read', 'tasks:read', 'interactions:read']
export const AGENT_SCOPES = ['webhooks:read', 'webhooks:write']
export const URL_OK = 'https://example.com/hook'
export const NO_SUCH = '0190b2c4-0000-7000-8000-00000000dead'

export interface Who {
  /** `user`: the seeded owner. `agent`: an agent (default the seeded one). */
  as: 'user' | 'agent'
  id?: string
  scopes?: string[]
}
export interface Res {
  status: number
  text: string
  body: any
}

export interface WebhookKit {
  e: Engine
  /** The runtime the registry was built with. */
  runtime: WebhooksRuntime
  app: ReturnType<typeof createApp>
  registry: ReturnType<typeof createVaultRegistry>
  call(who: Who, method: string, path: string, body?: unknown): Promise<Res>
  /** An owner call (the seeded user, every webhook scope). */
  owner(method: string, path: string, body?: unknown): Promise<Res>
  /** The seeded agent (or `id`) calling with webhook scopes (or `scopes`). */
  agent(method: string, path: string, body?: unknown, over?: { id?: string; scopes?: string[] }): Promise<Res>
  /** A new live, non-delegated agent whose STORED grants are `scopes` (what its subscriptions are judged by). */
  seedAgent(scopes: string[], over?: { name?: string; disabled?: boolean; delegated?: boolean }): Promise<string>
  /** Sets the stored grants of an agent (the seeded one has none). */
  grant(agentId: string, scopes: string[]): Promise<void>
  /** Creates a subscription as the owner for `agentId`; asserts success. */
  create(agentId: string, body?: Record<string, unknown>): Promise<any>
  all<T = Record<string, any>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  close(): Promise<void>
  reset(): Promise<void>
}

export async function openWebhookKit(opts: { key?: Uint8Array | null; version?: number; allowInsecureUrls?: boolean; clock?: () => Date } = {}): Promise<WebhookKit> {
  const e = await openD1Engine()
  const runtime: WebhooksRuntime = { key: opts.key === null ? null : { bytes: opts.key ?? KEY_BYTES, version: opts.version ?? 3 }, allowInsecureUrls: opts.allowInsecureUrls ?? false }
  const registry = createVaultRegistry({ webhooks: runtime })
  const clock = opts.clock ?? (() => NOW)
  const kit = {} as WebhookKit
  const build = () => createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator(), clock, newId: () => uuidv7(clock()) })
  Object.assign(kit, {
    e,
    runtime,
    registry,
    app: build(),
    async reset() {
      await e.reset()
      kit.app = build()
    },
    async call(who: Who, method: string, path: string, body?: unknown): Promise<Res> {
      const token = mintTestUserToken({ userId: who.id ?? (who.as === 'agent' ? e.agentId : e.userId), organizationId: e.organizationId, scopes: who.scopes ?? OWNER_SCOPES, kind: who.as })
      const res = await kit.app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text()
      return { status: res.status, text, body: text ? JSON.parse(text) : null }
    },
    owner: (method: string, path: string, body?: unknown) => kit.call({ as: 'user' }, method, path, body),
    agent: (method: string, path: string, body?: unknown, over: { id?: string; scopes?: string[] } = {}) => kit.call({ as: 'agent', id: over.id ?? e.agentId, scopes: over.scopes ?? AGENT_SCOPES }, method, path, body),
    async seedAgent(scopes: string[], over: { name?: string; disabled?: boolean; delegated?: boolean } = {}) {
      const id = uuidv7()
      const at = '2026-10-22T08:00:00.000Z'
      await e.d1!.batch([
        e.d1!.prepare('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)').bind(id, 'agent', at),
        e
          .d1!.prepare('INSERT INTO agents (id, created_at, updated_at, organization_id, name, scopes, created_by, disabled_at, auth_provider, auth_client_id, delegated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, at, at, e.organizationId, over.name ?? `agent-${id.slice(-4)}`, JSON.stringify(scopes), e.userId, over.disabled ? at : null, over.delegated ? 'clerk' : null, over.delegated ? `client_${id.slice(-6)}` : null, over.delegated ? e.userId : null),
      ])
      return id
    },
    async grant(agentId: string, scopes: string[]) {
      await e.d1!.prepare('UPDATE agents SET scopes = ? WHERE id = ?').bind(JSON.stringify(scopes), agentId).run()
    },
    async create(agentId: string, body: Record<string, unknown> = {}) {
      const r = await kit.owner('POST', '/meta/v1/webhooks', { url: URL_OK, event_types: ['task.created'], agent_id: agentId, ...body })
      if (r.status >= 300) throw new Error(`create failed ${r.status}: ${r.text}`)
      return r.body
    },
    async all(sqlText: string, ...binds: unknown[]) {
      return ((await e.d1!.prepare(sqlText).bind(...binds).all()).results ?? []) as any[]
    },
    close: () => e.close(),
  })
  return kit
}
