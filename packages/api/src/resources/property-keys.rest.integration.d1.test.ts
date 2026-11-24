import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'

// [[CORE318]] D11 (cycle 2, CORE549): `<resource>.property_keys`, the keys in use on a resource's live records with the record count and the JSON types seen,
// never a value (P5), on contacts over REST and MCP. A read: no event, no write (P7). The custom object's case is custom/bag.integration.d1.test.ts.
let k: ActionKit
let writer: Actor
let reader: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  writer = await k.actor('writer', 'agent', ['contacts:read', 'contacts:write', 'companies:read', 'companies:write'])
  reader = await k.actor('reader', 'agent', ['contacts:read'])
})

const PATH = '/api/v1/contacts/property-keys'
const make = async (name: string, additional_props?: Record<string, unknown>) => {
  const r = await k.call(writer, 'POST', '/api/v1/contacts', {
    name,
    ...(additional_props ? { additional_props } : {}),
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}
const keys = async (as: Actor = reader) => {
  const r = await k.call(as, 'GET', PATH)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body
}

describe('the answer (P5)', () => {
  it('an empty table and a table of {} bags answer data: [] (empty state)', async () => {
    expect(await keys()).toEqual({ data: [], truncated: false })
    await make('a')
    await make('b', {})
    expect(await keys()).toEqual({ data: [], truncated: false })
  })

  it('counts records per key, the sorted set of types seen, ordered by records desc then key asc', async () => {
    await make('a', { city: 'Paris', employees: 40, verified: true, zeta: 1 })
    await make('b', { city: 'Rome', employees: 'many', verified: false, alpha: 'x' })
    await make('c', { city: 'Oslo' })
    const body = await keys()
    expect(body.data).toEqual([
      { key: 'city', records: 3, types: ['string'] },
      { key: 'employees', records: 2, types: ['number', 'string'] },
      { key: 'verified', records: 2, types: ['boolean'] },
      { key: 'alpha', records: 1, types: ['string'] },
      { key: 'zeta', records: 1, types: ['number'] },
    ])
    expect(body.truncated).toBe(false)
  })

  it('a fractional number and a boolean are told apart from strings; all three types sort alphabetically', async () => {
    await make('a', { v: 1.5 })
    await make('b', { v: true })
    await make('c', { v: 'x' })
    expect((await keys()).data).toEqual([{ key: 'v', records: 3, types: ['boolean', 'number', 'string'] }])
  })

  it('no value appears anywhere in the body', async () => {
    await make('a', { city: 'Paris-secret-value', employees: 98765, flag: true })
    const text = JSON.stringify(await keys())
    expect(text).not.toContain('Paris-secret-value')
    expect(text).not.toContain('98765')
    expect(Object.keys((await keys()).data[0]).sort()).toEqual(['key', 'records', 'types'])
  })

  it('does not count a soft-deleted record or a merged (tombstoned) contact', async () => {
    const gone = await make('gone', { deleted_key: 1, shared: 'x' })
    await make('kept', { shared: 'y' })
    expect((await k.call(writer, 'DELETE', `/api/v1/contacts/${gone.id}`)).status).toBe(204)
    // A merge source whose key could not move to the survivor stays on the tombstone: the survivor holds 50 keys.
    const survivor = await make('survivor', Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])))
    const source = await make('source', { ghost: 1 })
    const merged = await k.call(writer, 'POST', `/api/v1/contacts/${survivor.id}/merge`, { source_id: source.id })
    expect(merged.status, JSON.stringify(merged.body)).toBe(200)
    const body = await keys()
    const names = body.data.map((d: any) => d.key)
    expect(names).not.toContain('deleted_key')
    expect(names).not.toContain('ghost')
    expect(body.data.find((d: any) => d.key === 'shared').records).toBe(1)
  })

  it('is cut at 200 keys and says so; exactly 200 keys is not truncated', async () => {
    const bag = (from: number, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`key_${String(from + i).padStart(3, '0')}`, 1]))
    for (let i = 0; i < 5; i++) await make(`r${i}`, bag(i * 41, 41))
    // 5 records x 41 distinct keys = 205 keys
    const body = await keys()
    expect(body.data).toHaveLength(200)
    expect(body.truncated).toBe(true)
    await k.reset()
    writer = await k.actor('writer', 'agent', ['contacts:read', 'contacts:write'])
    reader = await k.actor('reader', 'agent', ['contacts:read'])
    for (let i = 0; i < 4; i++) await make(`r${i}`, bag(i * 50, 50))
    const exact = await keys()
    expect(exact.data).toHaveLength(200)
    expect(exact.truncated).toBe(false)
  })

  it('counts only the caller organisation and answers 403 without the read scope', async () => {
    await make('a', { city: 'x' })
    const none = await k.actor('none', 'agent', ['companies:read'])
    const r = await k.call(none, 'GET', PATH)
    expect(r.status).toBe(403)
  })

  it('writes nothing: no event is added, and GET {id} is not what answers the path', async () => {
    await make('a', { city: 'x' })
    const before = (await k.events()).length
    await keys()
    expect((await k.events()).length).toBe(before)
    const r = await k.call(reader, 'GET', PATH)
    expect(r.body).toHaveProperty('truncated')
  })

  it('is not proposable: the registry marks no proposal for it', () => {
    const op = k.registry.operations().find((o) => o.name === 'contacts.property_keys')
    expect(op).toBeDefined()
    expect((op as any).proposal ?? undefined).toBeUndefined()
    expect(op!.scope).toEqual({ resource: 'contacts', action: 'read' })
  })
})

describe('on every surface (D11)', () => {
  it('OpenAPI has GET /api/v1/contacts/property-keys; MCP has contacts_property_keys', async () => {
    await make('a', { city: 'x' })
    const doc = await k.call(reader, 'GET', '/api/v1/openapi.json')
    expect(doc.body.paths[PATH].get.operationId).toBe('contacts.property_keys')
    const tools = await k.call(reader, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(tools.body.result.tools.map((t: any) => t.name)).toContain('contacts_property_keys')
    const called = await k.call(reader, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'contacts_property_keys', arguments: {} },
    })
    expect(called.body.result.structuredContent).toEqual({
      data: [{ key: 'city', records: 1, types: ['string'] }],
      truncated: false,
    })
  })

  it('every object with a bag has the read, and nothing else does', () => {
    const names = k.registry
      .operations()
      .filter((o) => o.name.endsWith('.property_keys'))
      .map((o) => o.name)
    expect(names.sort()).toEqual([
      'companies.property_keys',
      'contacts.property_keys',
      'deals.property_keys',
      'tasks.property_keys',
    ])
  })
})
