import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, seedUser, truncateAll } from '@vault/db/test'
import { postgresBinding } from '@vault/storage-postgres'
import type { AnyResource, Registry } from '../registry.js'
import { CRUD_ACTIONS, crudActions, resourcePath, scopeResourceOf, type CrudAction } from '../resources/define.js'
import { createApp, type AppEnv } from '../rest/app.js'
import { seedApiKey } from './keys.js'
import { seedTenant, type Tenant } from './tenant.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

export type ContractActor = 'agent' | 'user'
export type ContractGrant = 'full' | 'read' | 'none'
/**
 * What a fixture's `input`, `patch` and `make` get (CORE36 P8, CORE40 P10): they run OUTSIDE any transaction, on every
 * backend. `post` creates a prerequisite row through the public API as the tenant's user with every declared scope and
 * throws on a non-2xx; `seedMember` seeds a user with a live membership in the tenant's organisation (memberships have
 * no public writer: Clerk is the source, CORE3 D1);
 */
export interface FixtureKit {
  tenant: ContractTenant
  post(path: string, body: unknown): Promise<{ id: string }>
  seedMember(role?: 'owner' | 'member'): Promise<{ userId: string; membershipId: string }>
}
export interface ContractFixture {
  /** A valid create body. Required iff the definition generates `create`. May create prerequisite rows through `kit`. */
  input?: (kit: FixtureKit) => Promise<Record<string, unknown>>
  /** A valid, non-empty update body. Required iff the definition generates `update`. */
  patch?: (kit: FixtureKit) => Promise<Record<string, unknown>>
  /** Creates one live row; returns its id. Default: POST `input`.
   *  Required when the definition does not generate `create` (read-only resources). */
  make?: (kit: FixtureKit) => Promise<{ id: string }>
  /** Generic routes served by a hand-written operation; the "not generated" case skips them. */
  handwritten?: readonly CrudAction[]
  /** Default ['agent', 'user']. */
  actors?: readonly ContractActor[]
}
export type ContractTenant = Tenant
export type EventRow = Record<string, any>
export interface ContractEnv {
  app: OpenAPIHono<AppEnv>
  /** Postgres pools (`vault_app`, owner); on other backends these are unusable stand-ins. */
  db: Kysely<Database>
  owner: Kysely<Database>
  countEvents(): Promise<number>
  countRows(table: string): Promise<number>
  /** A live row made through the public API as the tenant's user (no storage handle needed). */
  make(t: ContractTenant, def: AnyResource, fixture: ContractFixture): Promise<{ id: string }>
  /** The public record of a row as the tenant's user, via GET. */
  read(t: ContractTenant, def: AnyResource, id: string): Promise<unknown>
  a: ContractTenant
  b: ContractTenant
  /** One request as the tenant's principal; `grant` picks its scopes. */
  call(t: ContractTenant, actor: ContractActor, grant: ContractGrant, method: string, path: string, body?: unknown): Promise<Response>
  /** The id of the principal `call` uses for this actor and grant (what events record as `actor_id`). */
  principalId(t: ContractTenant, actor: ContractActor, grant: ContractGrant): Promise<string>
  /** The fixture kit of a tenant: prerequisite rows over the public API. */
  kit(t: ContractTenant, def: AnyResource): FixtureKit
  eventsOf(resourceId: string): Promise<EventRow[]>
}
export type ContractCheck = (def: AnyResource, fixture: ContractFixture, env: () => ContractEnv) => void

/**
 * Where a contract run executes ([[CORE35]] D16): the same assertions run on every backend. A session owns its
 * stores, tenants, authentication stand-in and event reads; the suite owns the assertions.
 */
export interface ContractSession {
  app: OpenAPIHono<AppEnv>
  db: Kysely<Database>
  owner: Kysely<Database>
  /** Empties the stores and seeds tenants A and B (one store per tenant on D1: never two tenants in one). */
  reset(): Promise<{ a: ContractTenant; b: ContractTenant }>
  close(): Promise<void>
  call(t: ContractTenant, actor: ContractActor, scopes: string[], method: string, path: string, body?: unknown): Promise<Response>
  principalId(t: ContractTenant, actor: ContractActor, scopes: string[]): Promise<string>
  /** Seeds a user with a live membership in the tenant's organisation. */
  seedMember(t: ContractTenant, role: 'owner' | 'member'): Promise<{ userId: string; membershipId: string }>
  eventsOf: ContractEnv['eventsOf']
  countEvents: ContractEnv['countEvents']
  countRows: ContractEnv['countRows']
}
export interface ContractBackend {
  name: string
  open(registry: Registry): Promise<ContractSession>
}

/** The Postgres backend: `vault_app` pool, owner pool for truncation and reads, the storage-postgres binding. */
export function postgresBackend(): ContractBackend {
  return {
    name: 'postgres',
    async open(registry) {
      const db = createTestDb()
      const owner = createOwnerTestDb()
      const storage = postgresBinding(db)
      const app = createApp({ registry, userAuthenticator: fakeUserAuthenticator(), storage: () => storage })
      const agents = new Map<string, { id: string; key: string }>()
      const agentFor = async (t: ContractTenant, scopes: string[]) => {
        const k = `${t.organizationId}:${scopes.join(',')}`
        let agent = agents.get(k)
        if (!agent) {
          const row = await seedAgent(db, { organizationId: t.organizationId, createdBy: t.userId, scopes })
          const key = await seedApiKey(db, { organizationId: t.organizationId, agentId: row.id, createdBy: t.userId })
          agent = { id: row.id, key: key.key }
          agents.set(k, agent)
        }
        return agent
      }
      return {
        app,
        db,
        owner,
        async reset() {
          await truncateAll(owner)
          agents.clear()
          return { a: await seedTenant(db, 'A'), b: await seedTenant(db, 'B') }
        },
        async close() {
          await db.destroy()
          await owner.destroy()
        },
        async call(t, actor, scopes, method, path, body) {
          const token = actor === 'agent' ? (await agentFor(t, scopes)).key : mintTestUserToken({ userId: t.userId, organizationId: t.organizationId, scopes })
          return app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        },
        async principalId(t, actor, scopes) {
          return actor === 'agent' ? (await agentFor(t, scopes)).id : t.userId
        },
        async seedMember(t, role) {
          const u = await seedUser(db, { organizationId: t.organizationId, role })
          const m = await owner.selectFrom('memberships').select('id').where('user_id', '=', u.id).executeTakeFirstOrThrow()
          return { userId: u.id, membershipId: m.id }
        },
        eventsOf: (id) => owner.selectFrom('events').selectAll().where('resource_id', '=', id).orderBy('id').execute(),
        countEvents: async () => Number((await owner.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
        countRows: async (table) =>
          Number((await (owner as unknown as Kysely<Record<string, Record<string, unknown>>>).selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      }
    },
  }
}

/** The catalog case: every registered definition has a fixture and every fixture a definition. */
export function assertFixturesCoverRegistry(registry: Registry, fixtures: Readonly<Record<string, ContractFixture>>): void {
  const defined = new Set(registry.resources().map((d) => d.name))
  const fixed = new Set(Object.keys(fixtures))
  const missing = [...defined].filter((n) => !fixed.has(n))
  const stale = [...fixed].filter((n) => !defined.has(n))
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `contract fixtures out of step with the registry: missing fixtures for [${missing.join(', ')}], stale fixtures [${stale.join(', ')}]`,
    )
  }
}

const NO_SUCH = '0190b2c4-0000-7000-8000-00000000dead'
const METHOD: Record<CrudAction, string> = { list: 'GET', get: 'GET', create: 'POST', update: 'PATCH', delete: 'DELETE' }
const pathOf = (def: AnyResource, action: CrudAction, id = NO_SUCH): string =>
  action === 'list' || action === 'create' ? resourcePath(def) : `${resourcePath(def)}/${id}`

export function runContractSuite(opts: {
  registry: Registry
  fixtures: Readonly<Record<string, ContractFixture>>
  checks?: readonly ContractCheck[]
  /** Default: Postgres. The same assertions run on every backend passed. */
  backend?: ContractBackend
}): void {
  const { registry, fixtures, checks = [] } = opts
  const backend = opts.backend ?? postgresBackend()

  describe(`contract (${backend.name})`, () => {
    let session: ContractSession
    let db: Kysely<Database>
    let owner: Kysely<Database>
    let app: OpenAPIHono<AppEnv>
    let a: ContractTenant
    let b: ContractTenant

    beforeAll(async () => {
      session = await backend.open(registry)
      db = session.db
      owner = session.owner
      app = session.app
    })
    afterAll(async () => {
      await session.close()
    })
    beforeEach(async () => {
      ;({ a, b } = await session.reset())
    })

    it('every definition has a fixture', () => assertFixturesCoverRegistry(registry, fixtures))

    for (const def of registry.resources()) {
      const fixture = fixtures[def.name] ?? {}
      const ops = crudActions(def)
      const has = (action: CrudAction) => ops.includes(action)
      const scopeRes = scopeResourceOf(def)
      const scopeSets: Record<ContractGrant, string[]> = {
        full: [`${scopeRes}:read`, `${scopeRes}:write`],
        read: [`${scopeRes}:read`],
        none: [],
      }

      describe(def.name, () => {
        let env: ContractEnv
        beforeEach(() => {
          const call: ContractEnv['call'] = (t, actor, grant, method, path, body) => session.call(t, actor, scopeSets[grant], method, path, body)
          env = {
            app,
            db,
            owner,
            a,
            b,
            call,
            principalId: (t, actor, grant) => session.principalId(t, actor, scopeSets[grant]),
            kit: (t, d) => ({
              tenant: t,
              async post(path, body) {
                const res = await session.call(t, 'user', registry.declaredScopes(), 'POST', path, body)
                if (res.status < 200 || res.status >= 300) throw new Error(`fixture post ${path} failed: ${res.status} ${await res.text()}`)
                return (await res.json()) as { id: string }
              },
              seedMember: (role = 'member') => session.seedMember(t, role),
            }),
            eventsOf: session.eventsOf,
            countEvents: session.countEvents,
            countRows: session.countRows,
            async make(t, d, fx) {
              if (fx.make) return fx.make(env.kit(t, d))
              const input = await fx.input!(env.kit(t, d))
              const res = await call(t, 'user', 'full', 'POST', pathOf(d, 'create'), input)
              if (res.status !== 201) throw new Error(`fixture create failed: ${res.status} ${await res.text()}`)
              return (await res.json()) as { id: string }
            },
            async read(t, d, id) {
              return (await call(t, 'user', 'full', 'GET', pathOf(d, 'get', id))).json()
            },
          }
        })

        const op = (action: CrudAction) => registry.get(`${def.name}.${action}`)!
        const parse = (action: CrudAction, json: unknown) => op(action).response.schema!.parse(json)
        const make = (t: ContractTenant): Promise<{ id: string }> => env.make(t, def, fixture)
        const eventCount = () => env.countEvents()
        const types = (events: EventRow[], action: string) => events.filter((e) => e.type === `${def.eventName}.${action}`)
        const error = async (res: Response, status: number, code: string) => {
          expect(res.status).toBe(status)
          expect(((await res.json()) as any).error.code).toBe(code)
        }
        const bodyFor = async (action: CrudAction): Promise<unknown> =>
          action === 'create' ? {} : action === 'update' ? {} : undefined

        for (const actor of fixture.actors ?? (['agent', 'user'] as const)) {
          describe(`as ${actor}`, () => {
            if (has('create')) {
              it('create', async () => {
                const input = await fixture.input!(env.kit(a, def))
                const res = await env.call(a, actor, 'full', 'POST', pathOf(def, 'create'), input)
                expect(res.status).toBe(201)
                const body = (await res.json()) as any
                parse('create', body)
                const events = await env.eventsOf(body.id)
                expect(events).toHaveLength(1)
                expect(events[0]).toMatchObject({
                  type: `${def.eventName}.created`,
                  before: null,
                  actor_id: await env.principalId(a, actor, 'full'),
                  organization_id: a.organizationId,
                })
                expect(events[0]!.after).toEqual(body)
              })
            }
            if (has('get')) {
              it('get', async () => {
                const row = await make(a)
                const res = await env.call(a, actor, 'full', 'GET', pathOf(def, 'get', row.id))
                expect(res.status).toBe(200)
                const body = parse('get', await res.json()) as { id: string }
                expect(body.id).toBe(row.id)
              })
            }
            if (has('list')) {
              it('list', async () => {
                const row = await make(a)
                const res = await env.call(a, actor, 'full', 'GET', pathOf(def, 'list'))
                expect(res.status).toBe(200)
                const body = parse('list', await res.json()) as { data: { id: string }[]; next_cursor: string | null }
                expect(body).toHaveProperty('next_cursor')
                expect(body.data.map((r) => r.id)).toContain(row.id)
              })
            }
            if (has('update')) {
              it('update', async () => {
                const row = await make(a)
                const patch = await fixture.patch!(env.kit(a, def))
                const res = await env.call(a, actor, 'full', 'PATCH', pathOf(def, 'update', row.id), patch)
                expect(res.status).toBe(200)
                const body = parse('update', await res.json())
                const updated = types(await env.eventsOf(row.id), 'updated')
                expect(updated).toHaveLength(1)
                expect(updated[0]!.before).not.toBeNull()
                expect(updated[0]!.after).toEqual(body)
                expect(updated[0]!.actor_id).toBe(await env.principalId(a, actor, 'full'))
              })
            }
            if (has('delete')) {
              it('delete', async () => {
                const row = await make(a)
                const last = await (await env.call(a, actor, 'full', 'GET', pathOf(def, 'get', row.id))).json()
                const res = await env.call(a, actor, 'full', 'DELETE', pathOf(def, 'delete', row.id))
                expect(res.status).toBe(204)
                expect(await res.text()).toBe('')
                const deleted = types(await env.eventsOf(row.id), 'deleted')
                expect(deleted).toHaveLength(1)
                expect(deleted[0]!.before).toEqual(last)
                expect(deleted[0]!.after).toBeNull()
                await error(await env.call(a, actor, 'full', 'GET', pathOf(def, 'get', row.id)), 404, 'not_found')
              })
            }

            it('cross-tenant', async () => {
              const row = await make(b)
              const snapshot = () => env.read(b, def, row.id)
              const before = await snapshot()
              const eventsBefore = await env.eventsOf(row.id)
              if (has('get')) await error(await env.call(a, actor, 'full', 'GET', pathOf(def, 'get', row.id)), 404, 'not_found')
              if (has('update')) {
                const patch = await fixture.patch!(env.kit(a, def))
                await error(await env.call(a, actor, 'full', 'PATCH', pathOf(def, 'update', row.id), patch), 404, 'not_found')
              }
              if (has('delete')) await error(await env.call(a, actor, 'full', 'DELETE', pathOf(def, 'delete', row.id)), 404, 'not_found')
              if (has('list')) {
                const list = (await (await env.call(a, actor, 'full', 'GET', pathOf(def, 'list'))).json()) as { data: { id: string }[] }
                expect(list.data.map((r) => r.id)).not.toContain(row.id)
              }
              expect(await snapshot()).toEqual(before)
              expect(await env.eventsOf(row.id)).toEqual(eventsBefore)
            })

            if (has('create') || has('update')) {
              it('unknown field', async () => {
                const total = await eventCount()
                if (has('create')) {
                  const input = await fixture.input!(env.kit(a, def))
                  const rows = async () => ({ n: await env.countRows(def.table) })
                  const n = (await rows()).n
                  await error(await env.call(a, actor, 'full', 'POST', pathOf(def, 'create'), { ...input, zz_unknown: 1 }), 400, 'validation_error')
                  expect((await rows()).n).toBe(n)
                }
                if (has('update')) {
                  const row = await make(a)
                  const after = await eventCount()
                  await error(await env.call(a, actor, 'full', 'PATCH', pathOf(def, 'update', row.id), { zz_unknown: 1 }), 400, 'validation_error')
                  expect(await eventCount()).toBe(after)
                } else {
                  expect(await eventCount()).toBe(total)
                }
              })
            }

            it('missing scope', async () => {
              const total = await eventCount()
              for (const action of CRUD_ACTIONS.filter(has)) {
                await error(
                  await env.call(a, actor, 'none', METHOD[action], pathOf(def, action), await bodyFor(action)),
                  403,
                  'insufficient_scope',
                )
              }
              expect(await eventCount()).toBe(total)
            })

            it('read is not write', async () => {
              const row = await make(a)
              for (const action of ['create', 'update', 'delete'] as const) {
                if (!has(action)) continue
                const res = await env.call(a, actor, 'read', METHOD[action], pathOf(def, action, row.id), await bodyFor(action))
                await error(res, 403, 'insufficient_scope')
              }
              if (has('get')) expect((await env.call(a, actor, 'read', 'GET', pathOf(def, 'get', row.id))).status).toBe(200)
              if (has('list')) expect((await env.call(a, actor, 'read', 'GET', pathOf(def, 'list'))).status).toBe(200)
            })

            it('no credential', async () => {
              for (const action of CRUD_ACTIONS.filter(has)) {
                const res = await app.request(pathOf(def, action), { method: METHOD[action] })
                await error(res, 401, 'unauthenticated')
              }
            })

            const absent = CRUD_ACTIONS.filter((x) => !has(x) && !fixture.handwritten?.includes(x))
            if (absent.length > 0) {
              it('not generated', async () => {
                const doc = (await (await app.request('/openapi.json')).json()) as any
                for (const action of absent) {
                  const res = await env.call(a, actor, 'full', METHOD[action], pathOf(def, action), await bodyFor(action))
                  await error(res, 404, 'not_found')
                  const openApiPath = action === 'list' || action === 'create' ? resourcePath(def) : `${resourcePath(def)}/{id}`
                  expect(doc.paths[openApiPath]?.[METHOD[action].toLowerCase()]).toBeUndefined()
                }
              })
            }

            it('document', async () => {
              const doc = (await (await app.request('/openapi.json')).json()) as any
              for (const action of CRUD_ACTIONS.filter(has)) {
                const o = op(action)
                const entry = doc.paths[o.path]?.[o.method]
                expect(entry.operationId).toBe(o.name)
                expect(entry.summary).toBeTruthy()
              }
            })
          })
        }

        for (const check of checks) check(def, fixture, () => env)
      })
    }
  })
}
