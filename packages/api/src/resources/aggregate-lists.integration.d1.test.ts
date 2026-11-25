import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXTENSIBLE_OBJECTS } from '../custom/extend.js'
import { createVibaseRegistry } from '../operations.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { PROJECTS_KEY, PROJECTS_REFS, createCustomTables } from '../test/custom-objects.js'
import { defineCustomObject } from '../custom/resource.js'
import { mintTestUserToken } from '../test/user-auth.js'
import { applyExtend } from '../test/extension-kit.js'

// [[CORE615]] D1-D5: contacts, companies, tasks and a custom object aggregate like deals do, on REST and MCP (the CLI is in packages/cli), with the list's own filters;
// the fields are D14's kind table over every column filter (declared fields included, bag keys excluded); a function with no field is not a parameter.
const OBJECT = PROJECTS_KEY
const LISTS = [
  { list: 'contacts', key: 'name', body: (n: number) => ({ name: `C${n}` }), noun: 'contact' },
  { list: 'companies', key: 'name', body: (n: number) => ({ name: `Co${n}` }), noun: 'company' },
  { list: 'tasks', key: 'title', body: (n: number) => ({ title: `T${n}` }), noun: 'task' },
  { list: OBJECT, key: 'name', body: (n: number) => ({ name: `P${n}` }), noun: OBJECT },
] as const

const registry = createVibaseRegistry({ definitions: [defineCustomObject(OBJECT, PROJECTS_REFS)] })
let k: ActionKit
let owner: Actor
let all: Actor
beforeAll(async () => {
  k = await openActionKit({ registry })
  await createCustomTables(k.d1, OBJECT, PROJECTS_REFS)
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  all = k.as(k.owner, registry.declaredScopes())
  owner = all
})
const path = (list: string) => `/api/v1/${list}`
const make = async (list: string, body: Record<string, unknown>) => {
  const r = await k.call(owner, 'POST', path(list), body)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}
/** The list paged to the end, two at a time. */
const paged = async (list: string, query: string) => {
  const out: any[] = []
  let after = ''
  for (;;) {
    const r = await k.call(owner, 'GET', `${path(list)}?limit=2${query ? `&${query}` : ''}${after}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    out.push(...r.body.data)
    if (!r.body.next_cursor) return out
    after = `&after=${encodeURIComponent(r.body.next_cursor)}`
  }
}
const agg = (list: string, query = '', actor = owner) => k.call(actor, 'GET', `${path(list)}/aggregate${query ? `?${query}` : ''}`)
const mcp = async (method: string, params: unknown, scopes = registry.declaredScopes()) => {
  const res = await k.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mintTestUserToken({ userId: owner.id, organizationId: k.organizationId, scopes, kind: 'user' })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as any
}

describe.each(LISTS)('$list aggregates (D1)', ({ list, key, body, noun }) => {
  it('count equals the list paged to the end under three filter sets, soft-deleted rows not counted, no event written', async () => {
    const rows = [] as any[]
    for (const n of [1, 2, 3, 4, 5]) rows.push(await make(list, body(n)))
    const sets = ['', `${key}=eq.${(rows[0] as any)[key]}`, `${key}=eq.nothing-like-this`]
    for (const q of sets) {
      const before = (await k.events()).length
      const a = await agg(list, q)
      expect(a.status, JSON.stringify(a.body)).toBe(200)
      expect(a.body.count, q).toBe((await paged(list, q)).length)
      expect((await k.events()).length).toBe(before)
    }
    expect((await agg(list)).body.count).toBe(5)
    expect((await k.call(owner, 'DELETE', `${path(list)}/${rows[4].id}`)).status).toBe(204)
    expect((await agg(list)).body.count).toBe(4)
  })
  it('refuses without the read scope, and /aggregate is not captured by /{id}', async () => {
    const r = await agg(list, '', k.as(owner, ['tags:read']))
    expect(r.status).toBe(403)
    expect(r.body.error?.code ?? r.body.code).toBe('insufficient_scope')
    const ok = await agg(list)
    expect(ok.body).toEqual({ count: 0 })
  })
  it('MCP offers <list>_aggregate to a reader and answers it', async () => {
    await make(list, body(1))
    const names = (await mcp('tools/list', {})).result.tools.map((t: any) => t.name)
    expect(names).toContain(`${list}_aggregate`)
    expect((await mcp('tools/list', {}, ['tags:read'])).result.tools.map((t: any) => t.name)).not.toContain(
      `${list}_aggregate`,
    )
    const called = await mcp('tools/call', { name: `${list}_aggregate`, arguments: {} })
    expect(called.result.isError).not.toBe(true)
    expect(called.result.structuredContent).toEqual({ count: 1 })
  })
  it('the operation names its noun in the cost sentence and no index', () => {
    const op = registry.get(`${list}.aggregate`)!
    expect(op.description).toContain(`reads every live ${noun} that matches the filters, with no page limit`)
    expect(op.description).toContain(`reads every live ${noun} of the workspace`)
    expect(op.description).not.toMatch(/idx_|_idx\b/)
  })
})

describe('the set of aggregatable definitions (D1)', () => {
  it('equals EXTENSIBLE_OBJECTS plus the workspace custom objects, both ways', () => {
    const have = registry
      .resources()
      .filter((r) => (r as any).aggregate)
      .map((r) => r.name)
      .sort()
    expect(have).toEqual([...EXTENSIBLE_OBJECTS, OBJECT].sort())
  })
  it('a list excluded by design (notes) has no route, tool or command', async () => {
    expect(registry.get('notes.aggregate')).toBeUndefined()
    expect((await k.call(owner, 'GET', '/api/v1/notes/aggregate')).status).toBe(404)
    const names = (await mcp('tools/list', {})).result.tools.map((t: any) => t.name)
    expect(names).not.toContain('notes_aggregate')
  })
})

describe('fields by kind on a custom object (D2, D3, D4)', () => {
  it('sum/avg of the integer, min/max of text and enum and timestamp, no currency; a reference is refused naming the allowed fields', async () => {
    const co = await make('companies', { name: 'Acme' })
    await make(OBJECT, { name: 'a', budget: 5, stage: 'done', start_date: '2026-01-01T00:00:00Z', company: co.id })
    await make(OBJECT, { name: 'b', budget: 7, stage: 'active', start_date: '2026-03-01T00:00:00Z' })
    const r = await agg(OBJECT, 'sum=budget&avg=budget&min=stage,name&max=stage,start_date')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({
      count: 2,
      sum: { budget: 12 },
      avg: { budget: 6 },
      min: { stage: 'active', name: 'a' },
      max: { stage: 'done', start_date: '2026-03-01T00:00:00.000Z' },
    })
    expect(r.body.currency).toBeUndefined()
    const bad = await agg(OBJECT, 'min=company')
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('min takes:')
    expect(JSON.stringify(bad.body)).toContain('budget')
  })
  it('a sum past the safe integer is 400, not a rounded number', async () => {
    await make(OBJECT, { name: 'a', budget: Number.MAX_SAFE_INTEGER })
    await make(OBJECT, { name: 'b', budget: Number.MAX_SAFE_INTEGER })
    const r = await agg(OBJECT, 'sum=budget')
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('9007199254740991')
  })
  it('a bag key in any function is 400; the bag filter narrows count', async () => {
    await make(OBJECT, { name: 'a', additional_props: { city: 'Paris' } })
    await make(OBJECT, { name: 'b', additional_props: { city: 'Rome' } })
    for (const fn of ['sum', 'avg', 'min', 'max']) expect((await agg(OBJECT, `${fn}=city`)).status, fn).toBe(400)
    expect((await agg(OBJECT, `${'sum'}=additional_props`)).status).toBe(400)
    const r = await agg(OBJECT, `additional_props=${encodeURIComponent('city.eq.Paris')}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.count).toBe(1)
    const c = await make('contacts', { name: 'x', additional_props: { city: 'Paris' } })
    await make('contacts', { name: 'y', additional_props: { city: 'Rome' } })
    expect(c.id).toBeTruthy()
    expect((await agg('contacts', `additional_props=${encodeURIComponent('city.eq.Paris')}`)).body.count).toBe(1)
    expect((await agg('contacts', 'min=city')).status).toBe(400)
  })
})

describe('no parameter without a field (D5)', () => {
  it.each([
    ['contacts', 'sum', 'avg'],
    ['companies', 'sum', 'avg'],
    ['tasks', 'sum', 'avg'],
  ])('%s has no sum or avg parameter anywhere; naming one is a 400 with the per-function message', async (list, ...fns) => {
    const doc = (await k.call(owner, 'GET', '/api/v1/openapi.json')).body
    const params = doc.paths[`/api/v1/${list}/aggregate`].get.parameters.map((p: any) => p.name)
    const tool = (await mcp('tools/list', {})).result.tools.find((t: any) => t.name === `${list}_aggregate`)
    for (const fn of fns) {
      expect(params, fn).not.toContain(fn)
      expect(Object.keys(tool.inputSchema.properties), fn).not.toContain(fn)
      const r = await agg(list, `${fn}=x`)
      expect(r.status).toBe(400)
      expect(JSON.stringify(r.body)).toContain(`${fn}: ${list} has no integer field`)
      expect(JSON.stringify(r.body)).not.toContain('unknown filter')
    }
    for (const fn of ['min', 'max']) expect(params).toContain(fn)
    const schema = (await k.call(owner, 'GET', '/meta/v1/schema')).body
    const a = schema.tables.find((t: any) => t.name === list).resource.aggregate
    expect(a.sum).toEqual([])
    expect(a.avg).toEqual([])
  })
})

describe('an integer __c field on contacts brings sum and avg back (D5, D4)', () => {
  let x: ActionKit
  beforeAll(async () => {
    const extend = { contacts: { seats__c: { kind: 'integer' as const } } }
    x = await openActionKit({ registry: createVibaseRegistry({ extend }) })
    await applyExtend(x.d1, extend as never)
  })
  afterAll(() => x.close())
  beforeEach(() => x.reset())
  it('is offered and answers, with no currency key', async () => {
    for (const [n, seats] of [
      ['a', 3],
      ['b', 4],
    ] as const)
      expect((await x.call(x.owner, 'POST', '/api/v1/contacts', { name: n, seats__c: seats })).status).toBe(201)
    const doc = (await x.call(x.owner, 'GET', '/api/v1/openapi.json')).body
    const params = doc.paths['/api/v1/contacts/aggregate'].get.parameters.map((p: any) => p.name)
    expect(params).toEqual(expect.arrayContaining(['sum', 'avg']))
    const r = await x.call(x.owner, 'GET', '/api/v1/contacts/aggregate?sum=seats__c&avg=seats__c')
    expect(r.body).toEqual({ count: 2, sum: { seats__c: 7 }, avg: { seats__c: 3.5 } })
    const s = (await x.call(x.owner, 'GET', '/meta/v1/schema')).body
    expect(s.tables.find((t: any) => t.name === 'contacts').resource.aggregate).toMatchObject({
      sum: ['seats__c'],
      avg: ['seats__c'],
      money: {},
    })
  })
})

describe('deals extension fields keep the money rule on amount_minor only (D4)', () => {
  let x: ActionKit
  beforeAll(async () => {
    const extend = { deals: { seats__c: { kind: 'integer' as const } } }
    x = await openActionKit({ registry: createVibaseRegistry({ extend }) })
    await applyExtend(x.d1, extend as never)
  })
  afterAll(() => x.close())
  beforeEach(() => x.reset())
  it('a sum of seats__c is plain; amount_minor carries its currency', async () => {
    const p = await x.call(x.owner, 'POST', '/meta/v1/pipelines', { name: 'S' })
    const st = await x.call(x.owner, 'POST', '/meta/v1/pipeline-stages', {
      pipeline_id: p.body.id,
      name: 'Open',
      kind: 'open',
      position: 10,
    })
    for (const seats of [2, 3])
      expect(
        (
          await x.call(x.owner, 'POST', '/api/v1/deals', {
            name: 'd',
            stage_id: st.body.id,
            seats__c: seats,
            amount_minor: 100,
            currency: 'USD',
          })
        ).status,
      ).toBe(201)
    const r = await x.call(x.owner, 'GET', '/api/v1/deals/aggregate?sum=seats__c,amount_minor')
    expect(r.body).toEqual({ count: 2, sum: { seats__c: 5, amount_minor: 200 }, currency: { amount_minor: 'USD' } })
  })
})
