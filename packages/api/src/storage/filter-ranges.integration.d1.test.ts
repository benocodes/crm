import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { MAX_CONDITIONS } from './column-filters.js'
import { openActionKit, type ActionKit, type Actor, type Res } from '../test/action-kit.js'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '../test/custom-objects.js'
import { applyExtend, every } from '../test/extension-kit.js'

// [[CORE602]] D1-D5, D7, D8 on the D1 app over REST and MCP: a column filter carries 1 to 4 conditions that AND together, on every list kind.
const EXTEND = every({ seats__c: { kind: 'integer' } } as never)
const registry = createVibaseRegistry({ extend: EXTEND, definitions: [projectsDefinition()] })
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openActionKit({ registry })
  await applyExtend(k.d1, EXTEND)
  await createCustomTables(k.d1)
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  await applyExtend(k.d1, EXTEND)
  owner = await k.actor('all', 'agent', registry.declaredScopes())
})

const must = async (method: string, path: string, body?: unknown) => {
  const r = await k.call(owner, method, path, body)
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300)
  return r.body
}
const list = async (path: string, query: string, field = 'name') => {
  const r = await k.call(owner, 'GET', `${path}?${query}&limit=200`)
  expect(r.status, `${query} ${JSON.stringify(r.body)}`).toBe(200)
  return r.body.data.map((x: any) => x[field]).sort() as string[]
}
const refusal = (r: Res) => [r.status, r.body?.error?.code] as const
const mcp = async (name: string, args: Record<string, unknown>, actor = owner) => {
  const res = await k.call(actor, 'POST', '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  return res.body.result as { isError?: boolean; structuredContent: any }
}

/** d1..d5 close 11-01, 11-10, 11-20, 11-30, 12-05; d3 is EUR, the rest USD; amounts 100..500 (thousands). */
async function seedDeals() {
  const p = await must('POST', '/meta/v1/pipelines', { name: 'Sales' })
  const open = await must('POST', '/meta/v1/pipeline-stages', {
    pipeline_id: p.id,
    name: 'Open',
    kind: 'open',
    position: 10,
  })
  const rows: Array<[string, string, string, number]> = [
    ['d1', '2026-11-01', 'USD', 100000],
    ['d2', '2026-11-10', 'USD', 200000],
    ['d3', '2026-11-20', 'EUR', 300000],
    ['d4', '2026-11-30', 'USD', 400000],
    ['d5', '2026-12-05', 'USD', 500000],
  ]
  for (const [name, expected_close_date, currency, amount_minor] of rows)
    await must('POST', '/api/v1/deals', { stage_id: open.id, name, expected_close_date, currency, amount_minor })
}
const GTE = 'expected_close_date=gte.2026-11-10'
const LT = 'expected_close_date=lt.2026-11-30'

describe('ranges AND on every list kind (group 1)', () => {
  it('generic list (deals): both bounds, a second filter, either order', async () => {
    await seedDeals()
    expect(await list('/api/v1/deals', `${GTE}&${LT}`)).toEqual(['d2', 'd3'])
    expect(await list('/api/v1/deals', `${LT}&${GTE}`)).toEqual(['d2', 'd3'])
    expect(await list('/api/v1/deals', `${GTE}&${LT}&currency=eq.USD`)).toEqual(['d2'])
    expect(await list('/api/v1/deals', `amount_minor=gt.100000&amount_minor=lte.400000&currency=USD`)).toEqual([
      'd2',
      'd4',
    ])
  })
  it('deals.aggregate takes the same ranges', async () => {
    await seedDeals()
    const r = await k.call(owner, 'GET', `/api/v1/deals/aggregate?${GTE}&${LT}&sum=amount_minor`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.count).toBe(2)
    const usd = await k.call(owner, 'GET', `/api/v1/deals/aggregate?${GTE}&${LT}&currency=eq.USD`)
    expect(usd.body.count).toBe(1)
  })
  it('a built-in __c field (contacts.seats__c)', async () => {
    for (const [name, seats__c] of [
      ['s1', 1],
      ['s2', 5],
      ['s3', 10],
      ['s4', 15],
      ['s5', 20],
    ] as const)
      await must('POST', '/api/v1/contacts', { name, seats__c })
    expect(await list('/api/v1/contacts', 'seats__c=gte.5&seats__c=lt.15')).toEqual(['s2', 's3'])
    expect(await list('/api/v1/contacts', 'seats__c=lt.15&seats__c=gte.5&name=neq.s3')).toEqual(['s2'])
  })
  it('a custom object column', async () => {
    for (const [name, budget] of [
      ['p1', 100],
      ['p2', 200],
      ['p3', 300],
      ['p4', 400],
    ] as const)
      await must('POST', `/api/v1/${PROJECTS_KEY}`, { name, budget })
    expect(await list(`/api/v1/${PROJECTS_KEY}`, 'budget=gte.200&budget=lt.400')).toEqual(['p2', 'p3'])
    expect(await list(`/api/v1/${PROJECTS_KEY}`, 'budget=gte.200&budget=lt.400&name=neq.p2')).toEqual(['p3'])
  })
})

describe('MCP arrays (group 5)', () => {
  it('an array of conditions answers the range; a number is still eq; numbers in an array are stringified', async () => {
    await seedDeals()
    const range = await mcp('deals_list', { expected_close_date: ['gte.2026-11-10', 'lt.2026-11-30'] })
    expect(range.isError, JSON.stringify(range.structuredContent)).not.toBe(true)
    expect(range.structuredContent.data.map((d: any) => d.name).sort()).toEqual(['d2', 'd3'])
    const eq = await mcp('deals_list', { amount_minor: 500000 })
    expect(eq.structuredContent.data.map((d: any) => d.name)).toEqual(['d5'])
    const nums = await mcp('deals_list', { amount_minor: [200000, 300000] })
    expect(nums.isError).not.toBe(true)
    expect(nums.structuredContent.data).toEqual([])
    const one = await mcp('deals_list', { amount_minor: ['lt.200000'] })
    expect(one.structuredContent.data.map((d: any) => d.name)).toEqual(['d1'])
  })
  it('an array on a parameter that is not a column filter is refused, naming it', async () => {
    for (const arg of ['sort', 'tag', 'limit', 'after']) {
      const r = await mcp('deals_list', { [arg]: ['a', 'b'] })
      expect(r.isError, arg).toBe(true)
      expect(r.structuredContent.error.code).toBe('validation_error')
      expect(r.structuredContent.error.message, arg).toContain(arg)
    }
  })
  it('the cap and the empty list', async () => {
    const five = await mcp('deals_list', { name: ['a', 'b', 'c', 'd', 'e'] })
    expect(five.structuredContent.error).toMatchObject({ code: 'validation_error' })
    expect(five.structuredContent.error.message).toContain('at most 4 conditions')
    const none = await mcp('deals_list', { name: [] })
    expect(none.isError).toBe(true)
    expect(none.structuredContent.error.code).toBe('validation_error')
  })
  it('the tool input schema accepts the array', async () => {
    const tools = await k.call(owner, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tool = tools.body.result.tools.find((t: any) => t.name === 'deals_list')
    const p = tool.inputSchema.properties.expected_close_date
    expect(JSON.stringify(p)).toContain('"array"')
    expect(JSON.stringify(p)).toContain(`"maxItems":${MAX_CONDITIONS}`)
  })
})

describe('the cap and the refusals (group 2)', () => {
  it('4 conditions are accepted, 5 refused with D2 message', async () => {
    await seedDeals()
    const four = await k.call(owner, 'GET', `/api/v1/deals?name=neq.a&name=neq.b&name=neq.c&name=neq.d`)
    expect(four.status, JSON.stringify(four.body)).toBe(200)
    const five = await k.call(owner, 'GET', `/api/v1/deals?name=neq.a&name=neq.b&name=neq.c&name=neq.d&name=neq.e`)
    expect(refusal(five)).toEqual([400, 'validation_error'])
    expect(five.body.error.message).toBe('filter name: at most 4 conditions (got 5)')
  })
  it('a bad second condition names the filter and its position; a single bad one keeps today message', async () => {
    const two = await k.call(owner, 'GET', `/api/v1/deals?amount_minor=gt.1&amount_minor=abc`)
    expect(refusal(two)).toEqual([400, 'validation_error'])
    expect(two.body.error.message).toBe('filter amount_minor: condition 2: "abc" is not a safe integer')
    const one = await k.call(owner, 'GET', `/api/v1/deals?amount_minor=abc`)
    expect(one.body.error.message).toBe('filter amount_minor: "abc" is not a safe integer')
  })
  it('a caller without the read scope gets 403 before any condition is parsed', async () => {
    const nobody = await k.actor('nobody', 'agent', ['contacts:read'])
    const r = await k.call(nobody, 'GET', `/api/v1/deals?amount_minor=bad&amount_minor=worse&amount_minor=x&amount_minor=y&amount_minor=z`)
    expect(r.status).toBe(403)
  })
})

describe('only column filters repeat (group 3)', () => {
  const repeats = [
    'tag=a&tag=b',
    'sort=name&sort=id',
    'after=x&after=y',
    'limit=1&limit=2',
    'additional_props=a.eq.1&additional_props=b.eq.2',
  ]
  it.each(repeats)('%s is 400 validation_error', async (query) => {
    const r = await k.call(owner, 'GET', `/api/v1/deals?${query}`)
    expect(refusal(r), JSON.stringify(r.body)).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain('given 2 times')
  })
  it('a repeated aggregate function parameter is 400', async () => {
    const r = await k.call(owner, 'GET', `/api/v1/deals/aggregate?sum=amount_minor&sum=amount_minor`)
    expect(refusal(r)).toEqual([400, 'validation_error'])
  })
  it('the rule is read from the schema: a __c field no list names repeats fine', async () => {
    await must('POST', '/api/v1/contacts', { name: 'x', seats__c: 7 })
    expect(await list('/api/v1/contacts', 'seats__c=gte.5&seats__c=lt.9')).toEqual(['x'])
  })
})

describe('siblings (group 6)', () => {
  it('kind=eq.email still lets value normalise; two kind conditions make kind absent', async () => {
    const ok = await k.call(owner, 'GET', `/api/v1/identities?kind=eq.email&value=A@X.com`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const two = await k.call(owner, 'GET', `/api/v1/identities?kind=eq.email&kind=neq.phone&value=A@X.com`)
    expect(refusal(two)).toEqual([400, 'validation_error'])
    expect(two.body.error.message).toBe('filter value requires kind')
    const none = await k.call(owner, 'GET', `/api/v1/identities?value=A@X.com`)
    expect(none.body.error.message).toBe('filter value requires kind')
  })
})
