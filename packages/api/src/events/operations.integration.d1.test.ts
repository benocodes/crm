import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { uuidv7 } from '@vibase/storage'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { isAgentGrantable, scopesForRole } from '../auth/roles.js'
import { captureMessage } from '../test/capture-kit.js'
import { runCapture } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { coldStorage } from '../test/storage.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// API214 (D2, D3, D4, D5, D6, D17): events.list and events.get through the real router on D1.
const registry = createVaultRegistry()
const ALL = registry.declaredScopes()
const AT = '2026-11-12T10:00:00.000Z'
const NO_SUCH = '0190b2c4-0000-7000-8000-00000000dead'
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

const call = async (scopes: string[], path: string, init: { method?: string; body?: unknown; actor?: 'user' | 'agent' } = {}) => {
  const actor = init.actor ?? 'user'
  const token = mintTestUserToken({ userId: actor === 'agent' ? e.agentId : e.userId, organizationId: e.organizationId, scopes, kind: actor })
  const res = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null }
}
const must = async (path: string, init: Parameters<typeof call>[2]) => {
  const r = await call(ALL, path, init)
  expect(r.status, `${init?.method} ${path}: ${r.text}`).toBeLessThan(300)
  return r.body
}
const KEYS = ['actor_id', 'after', 'before', 'created_at', 'id', 'organization_id', 'resource_id', 'resource_type', 'type']
const list = async (scopes: string[], query = '') => call(scopes, `/api/v1/events${query ? `?${query}` : ''}`)
const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((x) => x.id)
/** A raw event row (setup only), in insert order, which is `seq` order. */
const rawEvent = async (type: string, resourceType: string, resourceId = uuidv7(), extra: { before?: unknown; after?: unknown } = {}) => {
  const id = uuidv7()
  await e
    .d1!.prepare('INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, AT, e.organizationId, type, resourceType, resourceId, e.userId, extra.before === undefined ? null : JSON.stringify(extra.before), extra.after === undefined ? null : JSON.stringify(extra.after))
    .run()
  return id
}
const TASKS = ['events:read', 'tasks:read']

describe('scope and surfaces (D4, D17)', () => {
  it('events.list and events.get need events:read: 403 insufficient_scope naming it, whatever else the caller holds', async () => {
    for (const path of ['/api/v1/events', `/api/v1/events/${NO_SUCH}`]) {
      const r = await call(ALL.filter((s) => s !== 'events:read'), path)
      expect([r.status, r.body.error.code], path).toEqual([403, 'insufficient_scope'])
      expect(r.body.error.message).toContain('events:read')
    }
  })

  it('events:read is declared, held by a member and grantable to an agent', () => {
    expect(ALL).toContain('events:read')
    expect(scopesForRole('member', ALL).has({ resource: 'events', action: 'read' })).toBe(true)
    expect(isAgentGrantable('events:read')).toBe(true)
  })

  it('both operations are in the api OpenAPI document and not the meta one', async () => {
    const api = (await (await app.request('/api/v1/openapi.json')).json()) as any
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    expect(api.paths['/api/v1/events'].get.operationId).toBe('events.list')
    expect(api.paths['/api/v1/events/{id}'].get.operationId).toBe('events.get')
    expect(JSON.stringify(meta.paths)).not.toContain('/events')
    const params = Object.fromEntries(api.paths['/api/v1/events'].get.parameters.map((p: any) => [p.name, p]))
    expect(Object.keys(params).sort()).toEqual(['after', 'limit', 'resource_id', 'resource_type', 'type'])
    expect(params.after.schema.format).toBeUndefined()
  })

  it('both operations are MCP tools for a holder of events:read', async () => {
    const token = mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes: ['events:read'], kind: 'agent' })
    const rpc = async (method: string, params: unknown) => (await (await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any
    const names = (await rpc('tools/list', {})).result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['events_list', 'events_get']))
    const out = await rpc('tools/call', { name: 'events_list', arguments: {} })
    expect(out.result.isError).not.toBe(true)
  })

  it('a binding that is not D1 answers 501 not_implemented, after the scope check and before any unit', async () => {
    const cold = createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() })
    const token = (scopes: string[]) => mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes, kind: 'user' })
    for (const path of ['/api/v1/events', `/api/v1/events/${NO_SUCH}`]) {
      const res = await cold.request(path, { headers: { authorization: `Bearer ${token(ALL)}` } })
      expect([res.status, ((await res.json()) as any).error.code], path).toEqual([501, 'not_implemented'])
      const denied = await cold.request(path, { headers: { authorization: `Bearer ${token(['tasks:read'])}` } })
      expect(denied.status).toBe(403)
    }
  })
})

describe('paging and cursor (D2, D5)', () => {
  it('an empty feed is an empty page with next_cursor null', async () => {
    const r = await list(TASKS)
    expect([r.status, r.body]).toEqual([200, { data: [], next_cursor: null }])
  })

  it('pages across limit with each filter alone and combined, reaching every matching event once in seq order', async () => {
    const t1 = uuidv7()
    const seeded: { id: string; type: string; resourceType: string; resourceId: string }[] = []
    const add = async (type: string, resourceType: string, resourceId = uuidv7()) => void seeded.push({ id: await rawEvent(type, resourceType, resourceId), type, resourceType, resourceId })
    await add('task.created', 'task', t1)
    await add('note.created', 'note')
    await add('task.updated', 'task', t1)
    await add('task.created', 'task')
    await add('note.updated', 'note')
    await add('task.updated', 'task')
    await add('task.updated', 'task', t1)
    const scopes = ['events:read', 'tasks:read', 'notes:read']
    const walk = async (query: string, limit: number) => {
      const got: string[] = []
      let after: string | null = null
      for (let guard = 0; guard < 20; guard++) {
        const r = await list(scopes, [query, `limit=${limit}`, after ? `after=${after}` : ''].filter(Boolean).join('&'))
        expect(r.status, r.text).toBe(200)
        got.push(...ids(r))
        if (r.body.next_cursor === null) return got
        expect(r.body.next_cursor).toBe(r.body.data.at(-1).id)
        after = r.body.next_cursor
      }
      throw new Error('walk did not terminate')
    }
    const expectFor = (f: (s: (typeof seeded)[number]) => boolean) => seeded.filter(f).map((s) => s.id)
    const cases: [string, string[]][] = [
      ['', expectFor(() => true)],
      ['type=task.updated', expectFor((s) => s.type === 'task.updated')],
      ['resource_type=task', expectFor((s) => s.resourceType === 'task')],
      [`resource_id=${t1}`, expectFor((s) => s.resourceId === t1)],
      [`type=task.updated&resource_id=${t1}`, expectFor((s) => s.type === 'task.updated' && s.resourceId === t1)],
      ['type=note.created&resource_type=note', expectFor((s) => s.type === 'note.created')],
      ['type=note.created&resource_type=task', []],
    ]
    for (const [query, expected] of cases) {
      for (const limit of [1, 2, 50]) expect(await walk(query, limit), `${query || '(none)'} limit ${limit}`).toEqual(expected)
    }
  })

  it('next_cursor is null on the page that exhausts the feed, even when it is exactly limit long', async () => {
    const [a, b] = [await rawEvent('task.created', 'task'), await rawEvent('task.created', 'task')]
    const r = await list(TASKS, 'limit=2')
    expect([ids(r), r.body.next_cursor]).toEqual([[a, b], null])
    const one = await list(TASKS, 'limit=1')
    expect([ids(one), one.body.next_cursor]).toEqual([[a], a])
  })

  it('limit 0 and 201 are 400 validation errors; 200 and the default are fine', async () => {
    for (const q of ['limit=0', 'limit=201', 'limit=x']) expect((await list(TASKS, q)).status, q).toBe(400)
    expect((await list(TASKS, 'limit=200')).status).toBe(200)
    await rawEvent('task.created', 'task')
    for (let i = 0; i < 52; i++) await rawEvent('task.created', 'task')
    const r = await list(TASKS)
    expect(r.body.data).toHaveLength(50)
    expect(r.body.next_cursor).toBe(r.body.data[49].id)
  })

  it('an unknown or malformed after is 400 invalid_cursor, with or without anything readable', async () => {
    await rawEvent('task.created', 'task')
    for (const scopes of [TASKS, ['events:read']]) {
      for (const after of [uuidv7(), '00000000-0000-7000-8000-000000000000', 'nope', 'x'.repeat(300)]) {
        const r = await list(scopes, `after=${after}`)
        expect([r.status, r.body.error?.code], `${scopes} ${after}`).toEqual([400, 'invalid_cursor'])
      }
    }
  })

  it('a known cursor with nothing readable is an empty page, not an error', async () => {
    const t = await rawEvent('task.created', 'task')
    const r = await list(['events:read'], `after=${t}`)
    expect([r.status, r.body]).toEqual([200, { data: [], next_cursor: null }])
    expect((await list(['events:read'])).body).toEqual({ data: [], next_cursor: null })
  })

  it('a cursor on an event the caller cannot read is valid and pages after it', async () => {
    const c = await rawEvent('contact.created', 'contact')
    const t = await rawEvent('task.created', 'task')
    expect(ids(await list(TASKS, `after=${c}`))).toEqual([t])
  })

  it('a filter naming a type the caller cannot read narrows to nothing: 200, never 403', async () => {
    await rawEvent('contact.created', 'contact')
    await rawEvent('task.created', 'task')
    for (const q of ['type=contact.created', 'resource_type=contact', 'type=nothing.at_all']) {
      const r = await list(TASKS, q)
      expect([r.status, r.body], q).toEqual([200, { data: [], next_cursor: null }])
    }
  })
})

describe('record shape and get (D3, D6)', () => {
  it('list and get return exactly the D6 keys, ISO timestamps, the read schema in after and no seq', async () => {
    const task = await must('/api/v1/tasks', { method: 'POST', body: { title: 'one' } })
    await must(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body: { title: 'two' } })
    const r = await list(TASKS)
    expect(r.body.data.map((x: any) => x.type)).toEqual(['task.created', 'task.updated'])
    for (const ev of r.body.data) {
      expect(Object.keys(ev).sort()).toEqual(KEYS)
      expect(ev.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect([ev.organization_id, ev.actor_id, ev.resource_type, ev.resource_id]).toEqual([e.organizationId, e.userId, 'task', task.id])
      expect(ev.after).toEqual(expect.objectContaining({ id: task.id }))
    }
    expect(r.body.data[0].before).toBeNull()
    expect(r.body.data[1].before.title).toBe('one')
    expect(r.body.data[1].after.title).toBe('two')
    expect(r.text).not.toMatch(/"seq"/)
    const g = await call(TASKS, `/api/v1/events/${r.body.data[1].id}`)
    expect([g.status, g.body]).toEqual([200, r.body.data[1]])
    expect(g.text).not.toMatch(/"seq"/)
  })

  it('before and after carry the read schema with embedded children, and nothing the read hides', async () => {
    await runCapture(e, { connection_id: uuidv7(), messages: [captureMessage(e.organizationId, { attachments: 1 })] })
    const scopes = ['events:read', 'interactions:read', 'messages:read', 'files:read']
    const r = await list(scopes)
    const created = (type: string) => r.body.data.find((x: any) => x.type === type)
    expect(r.body.data.map((x: any) => x.type)).toEqual(['thread.created', 'message.created', 'file.created', 'interaction.created'])
    for (const [type, path] of [
      ['message.created', 'messages'],
      ['interaction.created', 'interactions'],
      ['thread.created', 'threads'],
    ] as const) {
      const ev = created(type)
      const record = await call(scopes, `/api/v1/${path}/${ev.resource_id}`)
      expect(record.status, record.text).toBe(200)
      expect(Object.keys(ev.after).sort(), type).toEqual(Object.keys(record.body).sort())
    }
    expect(Object.keys(created('message.created').after)).toEqual(expect.arrayContaining(['attachments']))
    expect(r.text).not.toMatch(/storage_key|"content_key"/)
  })

  it('get of an unreadable, unknown or malformed id is the same 404', async () => {
    const c = await rawEvent('contact.created', 'contact')
    const unreadable = await call(TASKS, `/api/v1/events/${c}`)
    const unknown = await call(TASKS, `/api/v1/events/${NO_SUCH}`)
    const malformed = await call(TASKS, '/api/v1/events/nope')
    expect([unreadable.status, unknown.status, malformed.status]).toEqual([404, 404, 404])
    expect(unreadable.body).toEqual(unknown.body)
    expect(malformed.body).toEqual(unknown.body)
    expect(unknown.body.error.code).toBe('not_found')
    expect((await call([...TASKS, 'contacts:read'], `/api/v1/events/${c}`)).status).toBe(200)
  })

  it('ids are matched case-insensitively, as a UUID is', async () => {
    const [a, b] = [await rawEvent('task.created', 'task'), await rawEvent('task.updated', 'task')]
    expect(ids(await list(TASKS, `after=${a.toUpperCase()}`))).toEqual([b])
    expect((await call(TASKS, `/api/v1/events/${a.toUpperCase()}`)).body.id).toBe(a)
  })

  it('no write response carries an event id: the bodies of real writes and every response schema', async () => {
    const bodies: unknown[] = []
    const task = await must('/api/v1/tasks', { method: 'POST', body: { title: 'x' } })
    bodies.push(task, await must(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body: { title: 'y' } }))
    const contact = await must('/api/v1/contacts', { method: 'POST', body: { name: 'Ada' } })
    const company = await must('/api/v1/companies', { method: 'POST', body: { name: 'Acme' } })
    bodies.push(contact, company, await must('/api/v1/associations', { method: 'POST', body: { a_type: 'companies', a_id: company.id, b_type: 'contacts', b_id: contact.id } }))
    await must(`/api/v1/tasks/${task.id}`, { method: 'DELETE' })
    const eventIds = new Set((await e.events()).map((x) => String(x.id)))
    expect(eventIds.size).toBeGreaterThanOrEqual(6)
    const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
    expect(strings(bodies).filter((s) => eventIds.has(s))).toEqual([])
    const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [])
    for (const op of registry.operations()) {
      if (op.method === 'get' || !op.response.schema) continue
      expect(keys(z.toJSONSchema(op.response.schema, { io: 'output', unrepresentable: 'any' })).filter((k) => /^events?(_ids?)?$/.test(k)), op.name).toEqual([])
    }
  })
})
