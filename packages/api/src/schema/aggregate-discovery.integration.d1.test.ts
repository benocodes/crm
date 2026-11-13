import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { deals } from '../resources/deals.js'
import { buildSchemaDocument } from './build.js'
import { schemaDocument } from './document.js'

// [[CORE202]] D13, D19 on a real D1 and the real router: `schema.get` says which lists aggregate and how, the OpenAPI document and the MCP tool
// carry the operation, and the operation's description states its cost. Expected values are literals from D14's table, not read from the definition.
let e: Engine
let app: ReturnType<typeof createApp>
const registry = createVibaseRegistry()
beforeAll(async () => {
  e = await openD1Engine()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => {
  await e?.close()
})
const token = (scopes: string[]) => mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })
const get = async (path: string, scopes = ['schema:read', 'deals:read']) => {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token(scopes)}` } })
  return { status: res.status, body: (await res.json()) as any }
}
const rpc = async (method: string, params: unknown, scopes = ['deals:read', 'tags:read', 'associations:read']) => {
  const res = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token(scopes)}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return (await res.json()) as any
}
const tableOf = (doc: any, name: string) => doc.tables.find((t: any) => t.name === name)

const MINMAX = ['name', 'amount_minor', 'currency', 'expected_close_date', 'closed_at', 'created_at', 'updated_at']
const COST = 'reads every live deal that matches the filters, with no page limit'

describe('schema.get says which lists aggregate (D19)', () => {
  it('deals carries the field lists of D14 applied to its columns and the money declaration; the document still parses', async () => {
    const r = await get('/meta/v1/schema')
    expect(r.status).toBe(200)
    expect(() => schemaDocument.parse(r.body)).not.toThrow()
    expect(tableOf(r.body, 'deals').resource.aggregate).toEqual({ sum: ['amount_minor'], avg: ['amount_minor'], min: MINMAX, max: MINMAX, money: { amount_minor: 'currency' } })
    expect(tableOf(r.body, 'deals').resource.operations).toContain('deals.aggregate')
  })
  it('every other list has aggregate null, so null on all resources but deals', async () => {
    const r = await get('/meta/v1/schema')
    const resources = r.body.tables.filter((t: any) => t.resource !== null)
    expect(resources.length).toBeGreaterThan(15)
    for (const t of resources) expect(t.resource.aggregate, t.name).toBe(t.name === 'deals' ? tableOf(r.body, 'deals').resource.aggregate : null)
  })
  it('without a money declaration the discovery has no money fields (the declaration is what discovery reads)', () => {
    const without = { ...(deals as object), aggregate: { ...(deals as any).aggregate, money: {} } }
    const doc = buildSchemaDocument({ columns: [{ table_name: 'deals', cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 }], foreignKeys: [], resources: [without as never] })
    expect(tableOf(doc, 'deals').resource.aggregate.money).toEqual({})
  })
})

describe('the operation in OpenAPI and MCP (D13, D16)', () => {
  it('OpenAPI has GET /api/v1/deals/aggregate with the function parameters, the deals filters, no paging, and the generated cost sentence', async () => {
    const r = await get('/api/v1/openapi.json')
    const op = r.body.paths['/api/v1/deals/aggregate'].get
    expect(op.operationId).toBe('deals.aggregate')
    const names = op.parameters.map((p: any) => p.name)
    expect(names).toEqual(expect.arrayContaining(['sum', 'avg', 'min', 'max', 'amount_minor', 'currency', 'name', 'tag', 'tag_id', 'status', 'company_id']))
    for (const n of ['after', 'limit', 'sort', 'order']) expect(names, n).not.toContain(n)
    const param = (n: string) => op.parameters.find((p: any) => p.name === n).description as string
    expect(param('sum')).toContain('amount_minor')
    expect(param('avg')).toContain('amount_minor')
    for (const f of MINMAX) expect(param('min'), f).toContain(f)
    expect(param('max')).toContain('closed_at')
    expect(param('sum')).not.toContain('closed_at')
    expect(op.description).toContain(COST)
    expect(op.description).toContain('a filter schema.get marks `indexed` narrows that read through an index')
    expect(op.description).toContain('reads every live deal of the workspace')
    expect(op.description).toContain('currency=eq.')
    expect(op.description).not.toMatch(/idx_|index_deals|\bdeals_[a-z_]+_idx/)
  })
  it('the aggregate parameter descriptions are the ones schema.get field lists name (one table)', async () => {
    const doc = await get('/api/v1/openapi.json')
    const agg = tableOf((await get('/meta/v1/schema')).body, 'deals').resource.aggregate
    const op = doc.body.paths['/api/v1/deals/aggregate'].get
    for (const fn of ['sum', 'avg', 'min', 'max']) {
      const text = op.parameters.find((p: any) => p.name === fn).description as string
      for (const f of agg[fn]) expect(text, `${fn} ${f}`).toContain(f)
    }
  })
  it('the MCP tool deals_aggregate takes flat string arguments and answers structured content; contacts has no such tool', async () => {
    const pipeline = await e.insert('pipelines', { name: 'Sales' })
    const stage = await e.insert('pipeline_stages', { pipeline_id: pipeline.id, name: 'Open', kind: 'open', position: 1 })
    for (const [name, amount] of [['a', 100], ['b', 250]] as const) await e.insert('deals', { name, pipeline_id: pipeline.id, stage_id: stage.id, amount_minor: amount, currency: 'USD' })
    const list = await rpc('tools/list', {})
    const names = list.result.tools.map((t: any) => t.name)
    expect(names).toContain('deals_aggregate')
    expect(names).not.toContain('contacts_aggregate')
    const tool = list.result.tools.find((t: any) => t.name === 'deals_aggregate')
    for (const n of ['sum', 'avg', 'min', 'max', 'amount_minor', 'tag']) expect(tool.inputSchema.properties[n].type, n).toBe('string')
    for (const n of ['after', 'limit', 'sort', 'order']) expect(tool.inputSchema.properties[n], n).toBeUndefined()
    const called = await rpc('tools/call', { name: 'deals_aggregate', arguments: { sum: 'amount_minor', currency: 'eq.USD' } })
    expect(called.result.isError).not.toBe(true)
    expect(called.result.structuredContent).toEqual({ count: 2, sum: { amount_minor: 350 }, currency: { amount_minor: 'USD' } })
    const refused = await rpc('tools/call', { name: 'deals_aggregate', arguments: { sum: 'name' } })
    expect(refused.result.isError).toBe(true)
    // no deals:read, no tool
    expect((await rpc('tools/list', {}, ['tasks:read'])).result.tools.map((t: any) => t.name)).not.toContain('deals_aggregate')
  })
})
