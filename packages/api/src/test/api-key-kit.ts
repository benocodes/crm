// Test-only: never import from non-test code. The harness of the key-operation suites ([[CORE351]]): the D1 engine as the CRM database, a migrated control database beside it, the real control store
// as the port the four `api_keys.*` operations and the authenticator reach it through, an app with an injected clock, a caller that is the owner (a user) or an agent with explicit token scopes, and
// raw readers of both databases.
import { uuidv7 } from '@vibase/storage'
import { apiKeyStore, openControlDb, type D1Like } from '@vibase/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { generateApiKey } from '../auth/api-keys.js'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from './engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

export const NOW = new Date('2026-11-16T10:00:00.000Z')
export const NO_SUCH = '0190b2c4-0000-7000-8000-00000000dead'
export const OTHER_ORG = '0190b2c4-0000-7000-8000-0000000000ff'
export const OWNER_SCOPES = ['agents:read', 'agents:write']

export interface Who {
  as: 'user' | 'agent'
  id?: string
  scopes?: string[]
  /** The organisation the token claims (default: the seeded one). */
  org?: string
}
export interface Res {
  status: number
  text: string
  body: any
}

export interface ApiKeyKit {
  e: Engine
  /** The control-plane database the keys live in, migrated. */
  control: D1Like
  store: ReturnType<typeof apiKeyStore>
  app: ReturnType<typeof createApp>
  /** The injected clock: assign `clock.now` to move it. */
  clock: { now: Date }
  call(who: Who, method: string, path: string, body?: unknown): Promise<Res>
  /** An owner call (the seeded user, `agents:read` and `agents:write`). */
  owner(method: string, path: string, body?: unknown, scopes?: string[]): Promise<Res>
  /** The seeded agent calling with `scopes`. */
  agent(scopes: string[], method: string, path: string, body?: unknown): Promise<Res>
  /** A request authenticated by an API key, through the composed authenticator (control only, CORE329). */
  keyCall(key: string, path?: string): Promise<Res>
  /** Seeds a key row in the control database directly (no audit row); `over` sets any column. Returns the plaintext key and the id. */
  ctlKey(over?: Record<string, unknown>): Promise<{ key: string; id: string }>
  /** A new agent of the organisation, in the CRM database; returns its id. */
  seedAgent(): Promise<string>
  /** Creates a key through the operation as the owner; asserts success. */
  create(agentId?: string, body?: Record<string, unknown>): Promise<any>
  /** A raw read of the control database. */
  ctl<T = Record<string, any>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  /** A raw read of the CRM database. */
  crm<T = Record<string, any>>(sqlText: string, ...binds: unknown[]): Promise<T[]>
  /** `{ keys, events, audit }` row counts: what a refused operation must leave unchanged. */
  counts(): Promise<{ ctlKeys: number; events: number; audit: number }>
  close(): Promise<void>
  reset(): Promise<void>
}

export async function openApiKeyKit(): Promise<ApiKeyKit> {
  const e = await openD1Engine()
  const local: LocalD1 = await openLocalD1(['control'], { control: ['control'] })
  const control = local.bindings.control!
  const store = apiKeyStore(openControlDb(control))
  const clock = { now: NOW }
  const registry = createVibaseRegistry({ apiKeys: store } as never)
  const kit = {} as ApiKeyKit
  const build = () =>
    createApp({
      registry,
      storage: () => e.binding,
      userAuthenticator: fakeUserAuthenticator(),
      apiKeys: { port: store, store } as never,
      clock: () => clock.now,
      newId: () => uuidv7(clock.now),
    })
  const read = async (db: D1Like, sqlText: string, binds: unknown[]) =>
    ((
      await db
        .prepare(sqlText)
        .bind(...binds)
        .all()
    ).results ?? []) as any[]
  Object.assign(kit, {
    e,
    control,
    store,
    clock,
    app: build(),
    async reset() {
      await e.reset()
      await clearD1(control)
      clock.now = NOW
      kit.app = build()
    },
    async call(who: Who, method: string, path: string, body?: unknown): Promise<Res> {
      const token = mintTestUserToken({
        userId: who.id ?? (who.as === 'agent' ? e.agentId : e.userId),
        organizationId: who.org ?? e.organizationId,
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
    owner: (method: string, path: string, body?: unknown, scopes?: string[]) =>
      kit.call({ as: 'user', ...(scopes ? { scopes } : {}) }, method, path, body),
    agent: (scopes: string[], method: string, path: string, body?: unknown) =>
      kit.call({ as: 'agent', id: e.agentId, scopes }, method, path, body),
    async keyCall(key: string, path = '/meta/v1/me'): Promise<Res> {
      const res = await kit.app.request(path, { headers: { authorization: `Bearer ${key}` } })
      const text = await res.text()
      return { status: res.status, text, body: text ? JSON.parse(text) : null }
    },
    async ctlKey(over: Record<string, unknown> = {}) {
      const { key, hash, prefix } = await generateApiKey((n) => crypto.getRandomValues(new Uint8Array(n)))
      const at = NOW.toISOString()
      const row: Record<string, unknown> = {
        id: uuidv7(),
        created_at: at,
        updated_at: at,
        organization_id: e.organizationId,
        agent_id: e.agentId,
        key_hash: hash,
        prefix,
        last_used_at: null,
        revoked_at: null,
        expires_at: null,
        created_by: e.userId,
        ...over,
      }
      const cols = Object.keys(row)
      await control
        .prepare(`insert into api_keys (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`)
        .bind(...cols.map((c) => row[c]))
        .run()
      return { key, id: row.id as string }
    },
    async seedAgent() {
      const id = uuidv7()
      const at = NOW.toISOString()
      await e.d1!.batch([
        e.d1!.prepare('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)').bind(id, 'agent', at),
        e
          .d1!.prepare(
            'INSERT INTO agents (id, created_at, updated_at, organization_id, name, scopes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(id, at, at, e.organizationId, `agent-${id.slice(-4)}`, '[]', e.userId),
      ])
      return id
    },
    async create(agentId?: string, body: Record<string, unknown> = {}) {
      const r = await kit.owner('POST', '/meta/v1/api-keys', { agent_id: agentId ?? e.agentId, ...body })
      if (r.status >= 300) throw new Error(`create failed ${r.status}: ${r.text}`)
      return r.body
    },
    ctl: (sqlText: string, ...binds: unknown[]) => read(control, sqlText, binds),
    crm: (sqlText: string, ...binds: unknown[]) => read(e.d1!, sqlText, binds),
    async counts() {
      const n = async (db: D1Like, table: string) =>
        ((await db.prepare(`select count(*) as n from ${table}`).first()) as { n: number }).n
      return {
        ctlKeys: await n(control, 'api_keys'),
        events: await n(e.d1!, 'events'),
        audit: await n(control, 'control_audit'),
      }
    },
    close: async () => {
      await e.close()
      await local.dispose()
    },
  })
  return kit
}
