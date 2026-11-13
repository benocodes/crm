// Test-only. A local D1 deployment with the real app and the prepared path, for the action-request suites ([[AGT8]]): principals are seeded on
// demand (an id, a kind and the scopes the fake authenticator injects), the clock is injectable, and one hook can run between a unit's plan
// reads and its commit batch (a concurrent writer, deterministic).
import type { OpenAPIHono } from '@hono/zod-openapi'
import { uuidv7 } from '@vibase/storage'
import { d1Binding, type D1Like } from '@vibase/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedAgent, seedDeployment, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { createVaultRegistry } from '../operations.js'
import { createApp, type AppEnv, type AppOptions } from '../rest/app.js'
import type { Registry } from '../registry.js'
import type { D1Binding } from '@vibase/storage'
import { decodeRow, interceptD1, type RawRow } from './engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

export interface Actor {
  id: string
  kind: 'user' | 'agent'
  scopes: string[]
}
export type Res = { status: number; body: any }
export interface ActionKit {
  app: OpenAPIHono<AppEnv>
  d1: D1Like
  /** The binding the app (and a runner) uses; its D1 is the intercepted one. */
  binding: D1Binding
  registry: Registry
  organizationId: string
  /** The owner: a user with every declared scope. */
  owner: Actor
  /** Seeds a principal (a user with a membership, or an agent) and returns it with the scopes its requests carry. Same `name`, same principal. */
  actor(name: string, kind: 'user' | 'agent', scopes: string[]): Promise<Actor>
  /** The same principal under other scopes (a credential narrowed or widened). */
  as(actor: Actor, scopes: string[]): Actor
  call(actor: Actor, method: string, path: string, body?: unknown): Promise<Res>
  rows(table: string, where?: string, ...binds: unknown[]): Promise<RawRow[]>
  events(type?: string): Promise<RawRow[]>
  /** Runs `hook` once, after the next unit's plan reads and before its commit batch. */
  beforeCommit(hook: () => Promise<void>): void
  setNow(at: Date): void
  now(): Date
  reset(): Promise<void>
  close(): Promise<void>
}

export const ALL_DECLARED = createVaultRegistry().declaredScopes()
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)

export async function openActionKit(opts: { now?: Date; registry?: Registry; executions?: AppOptions['executions']; objects?: AppOptions['objects'] } = {}): Promise<ActionKit> {
  const local: LocalD1 = await openLocalD1(['ACTION'])
  const raw = local.bindings.ACTION!
  const pending: { hook: (() => Promise<void>) | null } = { hook: null }
  const d1 = interceptD1(raw, pending)
  const registry = opts.registry ?? createVaultRegistry()
  let clock = opts.now ?? new Date('2026-11-06T10:00:00.000Z')
  const kit = { binding: undefined as unknown as D1Binding, organizationId: '', owner: { id: '', kind: 'user', scopes: ALL_DECLARED } as Actor, app: undefined as unknown as OpenAPIHono<AppEnv> }
  const known = new Map<string, Actor>()
  const k: ActionKit = {
    get app() {
      return kit.app
    },
    d1: raw,
    get binding() {
      return kit.binding
    },
    registry,
    get organizationId() {
      return kit.organizationId
    },
    get owner() {
      return kit.owner
    },
    async actor(name, kind, scopes) {
      const have = known.get(name)
      if (have) return { ...have, scopes }
      const id = uuidv7()
      if (kind === 'user') {
        await seedPrincipal(raw, { id, kind: 'user' })
        await seedMembership(raw, { organizationId: kit.organizationId, userId: id, role: 'member' })
      } else await seedAgent(raw, { id, organizationId: kit.organizationId, createdBy: kit.owner.id, name })
      const a: Actor = { id, kind, scopes }
      known.set(name, a)
      return a
    },
    as: (actor, scopes) => ({ ...actor, scopes }),
    async call(actor, method, path, body) {
      const token = mintTestUserToken({ userId: actor.id, organizationId: kit.organizationId, scopes: actor.scopes, kind: actor.kind })
      const res = await kit.app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = res.status === 204 ? '' : await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    },
    async rows(table, where, ...binds) {
      const r = await raw.prepare(`select * from "${table}"${where ? ` where ${where}` : ''} order by rowid`).bind(...binds).all()
      return (r.results as RawRow[]).map((row) => (table in { events: 1 } ? { ...row, before: parse(row.before), after: parse(row.after) } : decodeRow(table, row)))
    },
    async events(type) {
      return k.rows('events', type ? 'type = ?' : undefined, ...(type ? [type] : []))
    },
    beforeCommit(hook) {
      pending.hook = hook
    },
    setNow(at) {
      clock = at
    },
    now: () => clock,
    async reset() {
      await clearD1(raw)
      pending.hook = null
      known.clear()
      const ids = { organizationId: uuidv7(), userId: uuidv7() }
      await seedDeployment(raw, { organizationId: ids.organizationId, externalId: 'org_action' })
      await seedPrincipal(raw, { id: ids.userId, kind: 'user' })
      await seedMembership(raw, { organizationId: ids.organizationId, userId: ids.userId, role: 'owner' })
      kit.organizationId = ids.organizationId
      kit.owner = { id: ids.userId, kind: 'user', scopes: ALL_DECLARED }
      const binding = d1Binding(d1, { organizationId: ids.organizationId, authProvider: 'clerk', authOrgId: 'org_action' })
      kit.binding = binding
      kit.app = createApp({ registry, userAuthenticator: fakeUserAuthenticator(), storage: () => binding, clock: () => clock, ...(opts.executions ? { executions: opts.executions } : {}), ...(opts.objects ? { objects:opts.objects } : {}) })
    },
    close: () => local.dispose(),
  }
  return k
}
