// Test-only: never import from non-test code. The webhook suites' harness ([[API7]]): the D1 engine, a registry with the webhook configuration injected, the app with
// an injected clock, a caller that is the owner (a user) or an agent with explicit token scopes, and raw readers of the three webhook tables.
import { uuidv7 } from '@vibase/storage'
import { openControlDb, webhookStore, type D1Like } from '@vibase/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { createVibaseRegistry } from '../operations.js'
import { dispatchWebhooks, type DispatchDeps, type DispatchSummary } from '../webhooks/dispatch.js'
import { createApp } from '../rest/app.js'
import type { WebhooksRuntime } from '../webhooks/config.js'
import { openD1Engine, type Engine } from './engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

export const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
export const KEY_B64 = Buffer.from(KEY_BYTES).toString('base64')
export const NOW = new Date('2026-11-12T10:00:00.000Z')
export const OWNER_SCOPES = [
  'webhooks:read',
  'webhooks:write',
  'events:read',
  'schema:read',
  'tasks:read',
  'interactions:read',
]
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
  /** The runtime the registry was built with (its `port` is the store over `control`). */
  runtime: WebhooksRuntime
  /** The control-plane database the subscriptions live in ([[CORE337]]), migrated; the CRM engine `e` holds none of the webhook tables' rows. */
  control: D1Like
  app: ReturnType<typeof createApp>
  registry: ReturnType<typeof createVibaseRegistry>
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
  /** A raw read. A statement naming a `webhook_*` table or `control_audit` reads the CONTROL database; every other reads the CRM engine's. */
  all<T = Record<string, any>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  /** A raw read of the CRM database whatever the statement names (the suites assert the CRM has no `webhook_*` table, [[CORE329]]). */
  crm<T = Record<string, any>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  /** The dependencies the dispatcher takes ([[API219]]): the engine's binding, the registry, the kit's clock and an id source on it. */
  deps(): DispatchDeps
  /** One dispatch tick, as the per-minute cron runs it. */
  dispatch(): Promise<DispatchSummary>
  /** A raw `events` row (the next `seq`), for events no operation emits; returns its id. `after`/`before` are stored as JSON. */
  rawEvent(
    type: string,
    over?: { resourceType?: string; resourceId?: string; after?: unknown; before?: unknown },
  ): Promise<string>
  /** A task created through the REST app as the owner (one `task.created` event); returns that event's id. */
  task(title: string): Promise<string>
  /** `webhook_dispatch_state.cursor_event_id` of a subscription. */
  cursorOf(subscriptionId: string): Promise<string>
  /** The raw delivery rows of a subscription (all when omitted), oldest id first. */
  deliveries(subscriptionId?: string): Promise<Record<string, any>[]>
  close(): Promise<void>
  reset(): Promise<void>
}

export async function openWebhookKit(
  opts: { key?: Uint8Array | null; version?: number; allowInsecureUrls?: boolean; clock?: () => Date } = {},
): Promise<WebhookKit> {
  const e = await openD1Engine()
  const local: LocalD1 = await openLocalD1(['control'], { control: ['control'] })
  const control = local.bindings.control!
  const port = webhookStore(openControlDb(control))
  const runtime: WebhooksRuntime = {
    key: opts.key === null ? null : { bytes: opts.key ?? KEY_BYTES, version: opts.version ?? 3 },
    allowInsecureUrls: opts.allowInsecureUrls ?? false,
    port,
  }
  const registry = createVibaseRegistry({ webhooks: runtime })
  const clock = opts.clock ?? (() => NOW)
  const kit = {} as WebhookKit
  // [[CORE337]] D12, [[CORE329]]: the CRM has no `webhook_*` table any more (migration 0020), so nothing can write one; checked before each reset and at close that none came back.
  const assertCrmUntouched = async () => {
    const left = (await e.d1!.prepare("select name from sqlite_master where name like 'webhook\\_%' escape '\\'").all())
      .results as Array<{ name: string }>
    if (left.length > 0) throw new Error(`the CRM has webhook table(s): ${left.map((r) => r.name).join(', ')}`)
  }
  const build = () =>
    createApp({
      registry,
      storage: () => e.binding,
      userAuthenticator: fakeUserAuthenticator(),
      clock,
      newId: () => uuidv7(clock()),
    })
  Object.assign(kit, {
    e,
    runtime,
    control,
    registry,
    app: build(),
    async reset() {
      await assertCrmUntouched()
      await e.reset()
      await clearD1(control)
      kit.app = build()
    },
    async call(who: Who, method: string, path: string, body?: unknown): Promise<Res> {
      const token = mintTestUserToken({
        userId: who.id ?? (who.as === 'agent' ? e.agentId : e.userId),
        organizationId: e.organizationId,
        scopes: who.scopes ?? OWNER_SCOPES,
        kind: who.as,
      })
      const res = await kit.app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, text, body: text ? JSON.parse(text) : null }
    },
    owner: (method: string, path: string, body?: unknown) => kit.call({ as: 'user' }, method, path, body),
    agent: (method: string, path: string, body?: unknown, over: { id?: string; scopes?: string[] } = {}) =>
      kit.call({ as: 'agent', id: over.id ?? e.agentId, scopes: over.scopes ?? AGENT_SCOPES }, method, path, body),
    async seedAgent(scopes: string[], over: { name?: string; disabled?: boolean; delegated?: boolean } = {}) {
      const id = uuidv7()
      const at = '2026-10-22T08:00:00.000Z'
      await e.d1!.batch([
        e.d1!.prepare('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)').bind(id, 'agent', at),
        e
          .d1!.prepare(
            'INSERT INTO agents (id, created_at, updated_at, organization_id, name, scopes, created_by, disabled_at, auth_provider, auth_client_id, delegated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            id,
            at,
            at,
            e.organizationId,
            over.name ?? `agent-${id.slice(-4)}`,
            JSON.stringify(scopes),
            e.userId,
            over.disabled ? at : null,
            over.delegated ? 'clerk' : null,
            over.delegated ? `client_${id.slice(-6)}` : null,
            over.delegated ? e.userId : null,
          ),
      ])
      return id
    },
    async grant(agentId: string, scopes: string[]) {
      await e.d1!.prepare('UPDATE agents SET scopes = ? WHERE id = ?').bind(JSON.stringify(scopes), agentId).run()
    },
    async create(agentId: string, body: Record<string, unknown> = {}) {
      const r = await kit.owner('POST', '/meta/v1/webhooks', {
        url: URL_OK,
        event_types: ['task.created'],
        agent_id: agentId,
        ...body,
      })
      if (r.status >= 300) throw new Error(`create failed ${r.status}: ${r.text}`)
      return r.body
    },
    deps: () => ({ binding: e.binding, port, registry, clock, newId: () => uuidv7(clock()) }),
    dispatch: () => dispatchWebhooks(kit.deps()),
    async rawEvent(
      type: string,
      over: { resourceType?: string; resourceId?: string; after?: unknown; before?: unknown } = {},
    ) {
      const id = uuidv7()
      const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v))
      await e
        .d1!.prepare(
          'INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          '2026-11-12T09:00:00.000Z',
          e.organizationId,
          type,
          over.resourceType ?? type.slice(0, type.indexOf('.')),
          over.resourceId ?? uuidv7(),
          e.userId,
          json(over.before),
          json(over.after),
        )
        .run()
      return id
    },
    async task(title: string) {
      const r = await kit.call({ as: 'user', scopes: [...OWNER_SCOPES, 'tasks:write'] }, 'POST', '/api/v1/tasks', {
        title,
      })
      if (r.status >= 300) throw new Error(`task failed ${r.status}: ${r.text}`)
      return (
        (await kit.all("select id from events where type = 'task.created' and resource_id = ?", r.body.id))[0] as {
          id: string
        }
      ).id
    },
    async cursorOf(subscriptionId: string) {
      return (
        (
          await kit.all('select cursor_event_id from webhook_dispatch_state where subscription_id = ?', subscriptionId)
        )[0] as { cursor_event_id: string }
      ).cursor_event_id
    },
    deliveries: (subscriptionId?: string) =>
      subscriptionId === undefined
        ? kit.all('select * from webhook_deliveries order by id')
        : kit.all('select * from webhook_deliveries where subscription_id = ? order by id', subscriptionId),
    async all(sqlText: string, ...binds: unknown[]) {
      const db = /\bwebhook_(subscriptions|secrets|dispatch_state|deliveries)\b|\bcontrol_audit\b/.test(sqlText)
        ? control
        : e.d1!
      return ((
        await db
          .prepare(sqlText)
          .bind(...binds)
          .all()
      ).results ?? []) as any[]
    },
    async crm(sqlText: string, ...binds: unknown[]) {
      return ((
        await e
          .d1!.prepare(sqlText)
          .bind(...binds)
          .all()
      ).results ?? []) as any[]
    },
    close: async () => {
      await assertCrmUntouched()
      await e.close()
      await local.dispose()
    },
  })
  return kit
}
