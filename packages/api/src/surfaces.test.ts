import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { uuidv7 } from '@vibase/storage'
import { createVibaseRegistry } from './operations.js'
import { Registry, type Operation } from './registry.js'
import { createApp } from './rest/app.js'
import { definePreparedResource } from './storage/definition.js'
import { coldStorage } from './test/storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from './test/user-auth.js'
import { SURFACE_PREFIX, fullPath, type Surface } from './surfaces.js'
import { tasks } from './resources/tasks.js'

// [[API32]]: every operation has a surface (D1, D6), the wire path is prefix + relative path (D3), one document per surface (D4).

/** D6, pinned operation by operation: the registry walk below fails on any operation missing here or placed elsewhere. */
const PLACEMENT: Record<string, Surface> = {}
const place = (surface: Surface, resource: string, actions: string[]) => {
  for (const a of actions) PLACEMENT[`${resource}.${a}`] = surface
}
const CRUD = ['list', 'get', 'create', 'update', 'delete']
for (const r of ['tasks', 'companies', 'contacts', 'notes', 'tags', 'deals']) place('api', r, CRUD)
place('api', 'deals', ['move_stage', 'aggregate'])
for (const r of ['pipelines', 'pipeline_stages']) place('meta', r, CRUD)
place('api', 'identities', [...CRUD, 'resolve'])
place('api', 'contacts', ['merge'])
for (const r of ['threads', 'messages', 'interactions', 'files', 'contact_files', 'company_files']) place('api', r, CRUD)
place('api', 'messages', ['content','send'])
place('api', 'files', ['content'])
place('api', 'associations', ['list', 'get', 'create', 'delete'])
place('api', 'action_requests', ['list', 'get', 'create', 'withdraw', 'approve', 'reject'])
place('api', 'action_executions', ['list', 'get'])
place('api', 'events', ['list', 'get'])
place('meta', 'agents', CRUD)
place('meta', 'connections', ['list', 'get', 'delete', 'authorize', 'sync'])
place('meta', 'api_keys', [...CRUD, 'revoke'])
place('meta', 'invitations', ['create', 'list', 'revoke'])
place('meta', 'memberships', ['list', 'get', 'update', 'delete'])
place('meta', 'users', ['list', 'get', 'issue_reset_link'])
place('meta', 'me', ['get'])
place('meta', 'schema', ['get'])
place('meta', 'webhooks', ['list', 'get', 'deliveries', 'create', 'update', 'delete', 'rotate_secret'])

/** CRUD actions the registry does not generate (read-only resources, hard-lived tables, no public writer). Listed, never filtered. */
const NOT_GENERATED = [
  ...['threads', 'messages', 'interactions', 'files'].flatMap((r) => [`${r}.create`, `${r}.update`, `${r}.delete`]),
  'contact_files.update', 'company_files.update',
  'memberships.create',
  'agents.delete',
  'api_keys.update', 'api_keys.delete',
]
for (const name of NOT_GENERATED) delete PLACEMENT[name]

const registry = createVibaseRegistry()
const ops = registry.operations()

describe('placement (D6)', () => {
  it('every registered operation sits on the surface the placement table gives it, and the table names nothing unregistered', () => {
    const actual = Object.fromEntries(ops.map((o) => [o.name, o.surface]))
    expect(actual).toEqual(PLACEMENT)
  })
  it('the actions listed as not generated are not registered', () => {
    for (const name of NOT_GENERATED) expect(registry.get(name), name).toBeUndefined()
  })
  it('the meta surface is exactly this list', () => {
    expect(ops.filter((o) => o.surface === 'meta').map((o) => o.name).sort()).toEqual([
      'agents.create', 'agents.get', 'agents.list', 'agents.update',
      'api_keys.create', 'api_keys.get', 'api_keys.list', 'api_keys.revoke',
      'connections.authorize', 'connections.delete', 'connections.get', 'connections.list', 'connections.sync',
      'invitations.create', 'invitations.list', 'invitations.revoke',
      'me.get',
      'memberships.delete', 'memberships.get', 'memberships.list', 'memberships.update',
      ...['pipelines', 'pipeline_stages'].flatMap((r) => CRUD.map((a) => `${r}.${a}`)),
      'schema.get',
      'users.get', 'users.issue_reset_link', 'users.list',
      'webhooks.create', 'webhooks.delete', 'webhooks.deliveries', 'webhooks.get', 'webhooks.list', 'webhooks.rotate_secret', 'webhooks.update',
    ].sort())
    expect(ops.length).toBe(114)
  })
  it('names stay unique across both surfaces', () => {
    expect(new Set(ops.map((o) => o.name)).size).toBe(ops.length)
    expect(new Set(ops.map((o) => o.name.replaceAll('.', '_'))).size).toBe(ops.length)
  })
  it('the full path is the surface prefix plus the relative path', () => {
    const me = registry.get('me.get')!
    expect(me.path).toBe('/me')
    expect(fullPath(me)).toBe('/meta/v1/me')
    expect(fullPath(registry.get('contacts.merge')!)).toBe('/api/v1/contacts/{id}/merge')
    expect(fullPath(registry.get('api_keys.revoke')!)).toBe('/meta/v1/api-keys/{id}/revoke')
  })
})

describe('type-level: surface is required (D1)', () => {
  it('a resource definition and a hand-written operation without a surface do not compile', () => {
    // @ts-expect-error surface is required on a resource definition
    const noSurfaceDef = () => definePreparedResource({ name: 'x', eventName: 'x', table: 'tasks', record: z.object({ id: z.uuid() }) })
    // @ts-expect-error surface is required on a hand-written operation
    const noSurfaceOp: Operation = {
      kind: 'tenant',
      name: 'probe.noop',
      summary: 'x',
      method: 'get',
      path: '/probe',
      scope: { resource: 'tasks', action: 'read' },
      response: { status: 200, schema: z.object({}) },
      prepare: () => {
        throw new Error('unused')
      },
    }
    expect(typeof noSurfaceDef).toBe('function')
    expect(noSurfaceOp.name).toBe('probe.noop')
  })
})

const docOf = async (app: ReturnType<typeof createApp>, path: string) => {
  const res = await app.request(path)
  expect(res.status).toBe(200)
  return (await res.json()) as any
}
const operationIds = (doc: any): string[] => Object.values<any>(doc.paths).flatMap((item) => Object.values<any>(item).map((o) => o.operationId))

describe('documents (D4, D5)', () => {
  const app = createApp({ storage: coldStorage() })
  it('each surface has a titled document listing exactly its operations at full paths, and no operation is in both', async () => {
    const api = await docOf(app, '/api/v1/openapi.json')
    const meta = await docOf(app, '/meta/v1/openapi.json')
    expect(api.info.title).toBe('Vibase records API')
    expect(meta.info.title).toBe('Vibase meta API')
    expect(api.openapi).toBe('3.1.0')
    for (const p of Object.keys(api.paths)) expect(p.startsWith('/api/v1/')).toBe(true)
    for (const p of Object.keys(meta.paths)) expect(p.startsWith('/meta/v1/')).toBe(true)
    const apiIds = operationIds(api).sort()
    const metaIds = operationIds(meta).sort()
    expect(apiIds).toEqual(ops.filter((o) => o.surface === 'api').map((o) => o.name).sort())
    expect(metaIds).toEqual(ops.filter((o) => o.surface === 'meta').map((o) => o.name).sort())
    expect(apiIds.filter((id) => metaIds.includes(id))).toEqual([])
    expect(apiIds).toEqual(expect.arrayContaining(['notes.create', 'associations.create', 'tasks.list']))
    expect(metaIds).toEqual(expect.arrayContaining(['me.get', 'agents.list', 'api_keys.revoke']))
    expect(Object.keys(api.paths)).toContain('/api/v1/contacts/{id}/merge')
    expect(Object.keys(meta.paths)).toContain('/meta/v1/api-keys/{id}/revoke')
  })
  it('the documents need no credential', async () => {
    expect((await app.request('/api/v1/openapi.json')).status).toBe(200)
    expect((await app.request('/meta/v1/openapi.json')).status).toBe(200)
  })
})

describe('duplicate routes are judged on the full path (D3)', () => {
  const op = (name: string, surface: Surface, path = '/probe', method: Operation['method'] = 'get'): Operation => ({
    kind: 'tenant',
    surface,
    name,
    summary: 's',
    method,
    path,
    scope: { resource: 'tasks', action: 'read' },
    response: { status: 200, schema: z.object({}) },
    prepare: () => {
      throw new Error('unused')
    },
  })
  it('the same relative path on both surfaces is allowed', () => {
    expect(() => new Registry().register(op('a.one', 'api')).register(op('b.one', 'meta'))).not.toThrow()
  })
  it('the same full path twice is refused', () => {
    expect(() => new Registry().register(op('a.one', 'api')).register(op('a.two', 'api'))).toThrow('duplicate route GET /api/v1/probe')
    expect(() => new Registry().register(op('b.one', 'meta')).register(op('b.two', 'meta'))).toThrow('duplicate route GET /meta/v1/probe')
  })
})

describe('unknown and cross-surface paths are 404 not_found (D5, D8)', () => {
  const app = createApp({ storage: coldStorage(), userAuthenticator: fakeUserAuthenticator() })
  const token = mintTestUserToken({ userId: uuidv7(), organizationId: uuidv7(), scopes: ['tasks:read'] })
  it.each(['/openapi.json', '/tasks', '/tasks/' + uuidv7(), '/me', '/agents', '/api/v1/agents', '/api/v1/me', '/meta/v1/tasks', '/meta/v1/notes', '/api/v1/nope'])('GET %s', async (path) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'no such route' } })
  })
  it('the prefixes are the fixed constants', () => {
    expect(SURFACE_PREFIX).toEqual({ api: '/api/v1', meta: '/meta/v1' })
  })
})

describe('auth and scopes are the same on both surfaces', () => {
  const app = createApp({ storage: coldStorage(), userAuthenticator: fakeUserAuthenticator() })
  const org = uuidv7()
  const as = (organizationId: string | null, scopes: string[]) => ({ authorization: `Bearer ${mintTestUserToken({ userId: uuidv7(), organizationId, scopes })}` })
  it.each(['/api/v1/tasks', '/meta/v1/agents'])('%s without credentials is 401 unauthenticated', async (path) => {
    const res = await app.request(path)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('unauthenticated')
  })
  it.each([
    ['/api/v1/tasks', 'tasks:read'],
    ['/meta/v1/agents', 'agents:read'],
  ])('%s without %s is 403 insufficient_scope', async (path, scope) => {
    const res = await app.request(path, { headers: as(org, []) })
    expect(res.status).toBe(403)
    const err = ((await res.json()) as any).error
    expect(err.code).toBe('insufficient_scope')
    expect(err.message).toContain(scope)
  })
  it.each(['/api/v1/tasks', '/meta/v1/agents'])('%s with no active organisation is 403 organization_required', async (path) => {
    const res = await app.request(path, { headers: as(null, ['tasks:read', 'agents:read']) })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('organization_required')
  })
})

describe('the shared tasks definition keeps a relative path', () => {
  it('resource operations carry the relative path and the definition surface', () => {
    const t = registry.get('tasks.list')!
    expect(t.path).toBe('/tasks')
    expect(t.surface).toBe(tasks.surface)
  })
})
