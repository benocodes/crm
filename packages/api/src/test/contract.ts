import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, truncateAll } from '@vault/db/test'
import { withContext, type ServiceContext } from '../context.js'
import type { Registry } from '../registry.js'
import { createResource, getResource } from '../resources/crud.js'
import { CRUD_ACTIONS, crudActions, resourcePath, scopeResourceOf, type CrudAction, type ResourceDefinition } from '../resources/define.js'
import { createApp, type AppEnv } from '../rest/app.js'
import { ScopeSet } from '../scopes.js'
import { seedApiKey } from './keys.js'
import { seedTenant, type Tenant } from './tenant.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

export type ContractActor = 'agent' | 'user'
export type ContractGrant = 'full' | 'read' | 'none'
export interface ContractFixture {
  /** A valid create body. Required iff the definition generates `create`. Runs in a committed
   *  `withContext` as the tenant's owner user, so it may create prerequisite rows first. */
  input?: (ctx: ServiceContext) => Promise<Record<string, unknown>>
  /** A valid, non-empty update body. Required iff the definition generates `update`. */
  patch?: (ctx: ServiceContext) => Promise<Record<string, unknown>>
  /** Creates one live row; returns its id. Default: `createResource(ctx, def, await input(ctx))`.
   *  Required when the definition does not generate `create` (read-only resources). */
  make?: (ctx: ServiceContext) => Promise<{ id: string }>
  /** Default ['agent', 'user']. */
  actors?: readonly ContractActor[]
}
export type ContractTenant = Tenant
export type EventRow = Record<string, any>
export interface ContractEnv {
  app: OpenAPIHono<AppEnv>
  db: Kysely<Database>
  owner: Kysely<Database>
  a: ContractTenant
  b: ContractTenant
  /** One request as the tenant's principal; `grant` picks its scopes. */
  call(t: ContractTenant, actor: ContractActor, grant: ContractGrant, method: string, path: string, body?: unknown): Promise<Response>
  /** The id of the principal `call` uses for this actor and grant (what events record as `actor_id`). */
  principalId(t: ContractTenant, actor: ContractActor, grant: ContractGrant): Promise<string>
  /** Runs fn in a committed context as the tenant's owner user, with the definition's read and write scopes. */
  as<T>(t: ContractTenant, def: ResourceDefinition<any>, fn: (ctx: ServiceContext) => Promise<T>): Promise<T>
  eventsOf(resourceId: string): Promise<EventRow[]>
}
export type ContractCheck = (def: ResourceDefinition<any>, fixture: ContractFixture, env: () => ContractEnv) => void

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
const pathOf = (def: ResourceDefinition<any>, action: CrudAction, id = NO_SUCH): string =>
  action === 'list' || action === 'create' ? resourcePath(def) : `${resourcePath(def)}/${id}`

export function runContractSuite(opts: {
  registry: Registry
  fixtures: Readonly<Record<string, ContractFixture>>
  checks?: readonly ContractCheck[]
}): void {
  const { registry, fixtures, checks = [] } = opts

  describe('contract', () => {
    let db: Kysely<Database>
    let owner: Kysely<Database>
    let app: OpenAPIHono<AppEnv>
    let a: ContractTenant
    let b: ContractTenant

    beforeAll(() => {
      db = createTestDb()
      owner = createOwnerTestDb()
      app = createApp({ db: () => db, registry, userAuthenticator: fakeUserAuthenticator() })
    })
    afterAll(async () => {
      await db.destroy()
      await owner.destroy()
    })
    beforeEach(async () => {
      await truncateAll(owner)
      a = await seedTenant(db, 'A')
      b = await seedTenant(db, 'B')
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
        const agents = new Map<string, { id: string; key: string }>()

        beforeEach(() => {
          agents.clear()
          const agentFor = async (t: ContractTenant, grant: ContractGrant) => {
            const k = `${t.organizationId}:${grant}`
            let agent = agents.get(k)
            if (!agent) {
              const row = await seedAgent(db, { organizationId: t.organizationId, createdBy: t.userId, scopes: scopeSets[grant] })
              const key = await seedApiKey(db, { organizationId: t.organizationId, agentId: row.id, createdBy: t.userId })
              agent = { id: row.id, key: key.key }
              agents.set(k, agent)
            }
            return agent
          }
          env = {
            app,
            db,
            owner,
            a,
            b,
            async call(t, actor, grant, method, path, body) {
              const token =
                actor === 'agent'
                  ? (await agentFor(t, grant)).key
                  : mintTestUserToken({ userId: t.userId, organizationId: t.organizationId, scopes: scopeSets[grant] })
              return app.request(path, {
                method,
                headers: { authorization: `Bearer ${token}` },
                body: body === undefined ? undefined : JSON.stringify(body),
              })
            },
            async principalId(t, actor, grant) {
              return actor === 'agent' ? (await agentFor(t, grant)).id : t.userId
            },
            as: (t, d, fn) =>
              withContext(
                db,
                {
                  actor: { id: t.userId, kind: 'user' },
                  organizationId: t.organizationId,
                  scopes: ScopeSet.parse([`${scopeResourceOf(d)}:read`, `${scopeResourceOf(d)}:write`]),
                },
                fn,
              ),
            eventsOf: (id) => owner.selectFrom('events').selectAll().where('resource_id', '=', id).orderBy('id').execute(),
          }
        })

        const op = (action: CrudAction) => registry.get(`${def.name}.${action}`)!
        const parse = (action: CrudAction, json: unknown) => op(action).response.schema!.parse(json)
        const make = (t: ContractTenant): Promise<{ id: string }> =>
          env.as(t, def, (ctx) => (fixture.make ? fixture.make(ctx) : fixture.input!(ctx).then((input) => createResource(ctx, def, input))))
        const eventCount = async () =>
          Number((await owner.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)
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
                const input = await env.as(a, def, fixture.input!)
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
                const patch = await env.as(a, def, fixture.patch!)
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
              const snapshot = () => env.as(b, def, (ctx) => getResource(ctx, def, row.id))
              const before = await snapshot()
              const eventsBefore = await env.eventsOf(row.id)
              if (has('get')) await error(await env.call(a, actor, 'full', 'GET', pathOf(def, 'get', row.id)), 404, 'not_found')
              if (has('update')) {
                const patch = await env.as(a, def, fixture.patch!)
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
                  const input = await env.as(a, def, fixture.input!)
                  const rows = () => owner.selectFrom(def.table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()
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

            const absent = CRUD_ACTIONS.filter((x) => !has(x))
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
