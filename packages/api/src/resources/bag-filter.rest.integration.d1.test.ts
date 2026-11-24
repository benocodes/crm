import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BAG_KEY, BAG_LIMITS } from '../storage/additional-props.js'
import { openActionKit, type ActionKit, type Actor, type Res } from '../test/action-kit.js'

// [[CORE318]] D9, D10 (cycle 2, CORE549): the `additional_props=<key>.<condition>` list filter on the four built-ins over REST and MCP on D1 (the oracle).
// Matching is P1 (a string by its text, a number or boolean by its compact JSON literal, case-sensitive), operators P2, an absent key P3, one condition P4.
let k: ActionKit
let writer: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
const RESOURCES = ['contacts', 'companies', 'deals', 'tasks', 'pipelines', 'schema']
beforeEach(async () => {
  await k.reset()
  writer = await k.actor(
    'writer',
    'agent',
    RESOURCES.flatMap((r) => [`${r}:read`, `${r}:write`]),
  )
})

const q = (condition: string) => `additional_props=${encodeURIComponent(condition)}`
const listNames = async (path: string, condition: string, field = 'name'): Promise<string[]> => {
  const r = await k.call(writer, 'GET', `${path}?${q(condition)}&limit=200`)
  expect(r.status, `${condition}: ${JSON.stringify(r.body)}`).toBe(200)
  return r.body.data.map((x: any) => x[field]).sort()
}
const refusal = (r: Res) => [r.status, r.body?.error?.code] as const

/** Five contacts: c1 numeric/boolean/string, c2 the same facts as strings, c3 other values, c4 no keys, c5 a fractional number. */
async function seedContacts() {
  const bags: Record<string, Record<string, unknown>> = {
    c1: { employees: 40, verified: true, city: 'Paris' },
    c2: { employees: '40', verified: 'true', city: 'paris' },
    c3: { employees: 41, verified: false },
    c4: {},
    c5: { employees: 40.5 },
  }
  for (const [name, additional_props] of Object.entries(bags)) {
    const r = await k.call(writer, 'POST', '/api/v1/contacts', { name, additional_props })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
  }
}

describe('the filter matrix on contacts (D10, P1 to P3)', () => {
  beforeEach(seedContacts)
  // [condition, the names it returns]
  const cases: Array<[string, string[]]> = [
    // a number, P1: the literal 40 matches 40 and "40", not 40.5 or 41
    ['employees.eq.40', ['c1', 'c2']],
    ['employees.40', ['c1', 'c2']],
    ['employees.eq.40.5', ['c5']],
    ['employees.neq.40', ['c3', 'c5']],
    ['employees.in.(40,41)', ['c1', 'c2', 'c3']],
    ['employees.is.null', ['c4']],
    ['employees.not.is.null', ['c1', 'c2', 'c3', 'c5']],
    // a string, P1: case-sensitive
    ['city.eq.Paris', ['c1']],
    ['city.Paris', ['c1']],
    ['city.neq.Paris', ['c2']],
    ['city.in.(Paris,paris)', ['c1', 'c2']],
    ['city.is.null', ['c3', 'c4', 'c5']],
    ['city.not.is.null', ['c1', 'c2']],
    // a boolean, P1: the literal true matches true and "true"
    ['verified.eq.true', ['c1', 'c2']],
    ['verified.true', ['c1', 'c2']],
    ['verified.neq.true', ['c3']],
    ['verified.in.(true,false)', ['c1', 'c2', 'c3']],
    ['verified.is.null', ['c4', 'c5']],
    ['verified.not.is.null', ['c1', 'c2', 'c3']],
    // an absent key behaves as a null column (P3): eq, neq and in never match it
    ['nope.eq.x', []],
    ['nope.neq.x', []],
    ['nope.in.(x,y)', []],
    ['nope.is.null', ['c1', 'c2', 'c3', 'c4', 'c5']],
    ['nope.not.is.null', []],
    // a prefixed key
    ['scorer:grade.eq.A', []],
  ]
  it.each(cases)('additional_props=%s', async (condition, names) => {
    expect(await listNames('/api/v1/contacts', condition)).toEqual(names)
  })

  it('a key with a prefix separator matches', async () => {
    const r = await k.call(writer, 'POST', '/api/v1/contacts', { name: 'g', additional_props: { 'scorer:grade': 'A' } })
    expect(r.status).toBe(201)
    expect(await listNames('/api/v1/contacts', 'scorer:grade.eq.A')).toEqual(['g'])
  })

  it('pages with the filter and composes with a column filter', async () => {
    const r = await k.call(writer, 'GET', `/api/v1/contacts?${q('employees.eq.40')}&name=eq.c1`)
    expect(r.body.data.map((x: any) => x.name)).toEqual(['c1'])
    const p1 = await k.call(writer, 'GET', `/api/v1/contacts?${q('employees.eq.40')}&limit=1`)
    expect(p1.body.data).toHaveLength(1)
    expect(p1.body.next_cursor).toBeTruthy()
    const p2 = await k.call(
      writer,
      'GET',
      `/api/v1/contacts?${q('employees.eq.40')}&limit=1&after=${p1.body.next_cursor}`,
    )
    expect(p2.body.data).toHaveLength(1)
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id)
  })
})

describe('every other object with a bag takes the filter (D10)', () => {
  it('companies, deals and tasks: one eq case each', async () => {
    const p = (await k.call(k.owner, 'POST', '/meta/v1/pipelines', { name: 'P' })).body.id
    const stage = (
      await k.call(k.owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: p,
        name: 'Open',
        kind: 'open',
        position: 1,
      })
    ).body.id
    const make = async (path: string, body: Record<string, unknown>) =>
      expect((await k.call(writer, 'POST', path, body)).status).toBe(201)
    await make('/api/v1/companies', { name: 'hit', additional_props: { tier: 'gold' } })
    await make('/api/v1/companies', { name: 'miss', additional_props: { tier: 'tin' } })
    await make('/api/v1/deals', { name: 'hit', stage_id: stage, additional_props: { tier: 'gold' } })
    await make('/api/v1/deals', { name: 'miss', stage_id: stage })
    await make('/api/v1/tasks', { title: 'hit', additional_props: { tier: 'gold' } })
    await make('/api/v1/tasks', { title: 'miss' })
    expect(await listNames('/api/v1/companies', 'tier.eq.gold')).toEqual(['hit'])
    expect(await listNames('/api/v1/deals', 'tier.eq.gold')).toEqual(['hit'])
    expect(await listNames('/api/v1/tasks', 'tier.eq.gold', 'title')).toEqual(['hit'])
  })

  it('MCP: contacts_list takes additional_props and filters', async () => {
    await seedContacts()
    const res = await k.call(writer, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'contacts_list', arguments: { additional_props: 'employees.eq.40' } },
    })
    const body = res.body.result
    expect(body.isError).not.toBe(true)
    expect(body.structuredContent.data.map((x: any) => x.name).sort()).toEqual(['c1', 'c2'])
    const tools = await k.call(writer, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    for (const t of ['contacts', 'companies', 'deals', 'tasks']) {
      const tool = tools.body.result.tools.find((x: any) => x.name === `${t}_list`)
      expect(tool.inputSchema.properties.additional_props.type, t).toBe('string')
    }
  })
})

describe('refusals (P2, P4)', () => {
  const bad: Array<[string, string]> = [
    ['a capital in the key', 'Abc.eq.1'],
    ['a double underscore in the key', 'a__b.eq.1'],
    ['a key of 65 characters', `${'a'.repeat(65)}.eq.1`],
    ['an empty key', '.eq.1'],
    ['no key and condition separator', 'justakey'],
    ['gt', 'x.gt.1'],
    ['gte', 'x.gte.1'],
    ['like', 'x.like.a*'],
    ['ilike', 'x.ilike.a*'],
    ['not.eq', 'x.not.eq.1'],
    ['not.in', 'x.not.in.(1,2)'],
    ['is.true', 'x.is.true'],
    ['is.false', 'x.is.false'],
  ]
  it.each(bad)('%s is 400 validation_error naming the filter', async (_n, condition) => {
    const r = await k.call(writer, 'GET', `/api/v1/contacts?${q(condition)}`)
    expect(refusal(r)).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain('additional_props')
  })
  it('a repeated bag parameter is refused, never last-wins', async () => {
    const r = await k.call(writer, 'GET', `/api/v1/contacts?${q('a.eq.1')}&${q('b.eq.2')}`)
    expect(refusal(r)).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain('additional_props')
  })
  it('a key containing a dot reads as the key before the first dot with the rest as its value', async () => {
    await k.call(writer, 'POST', '/api/v1/contacts', { name: 'a', additional_props: { a: 'b.c' } })
    expect(await listNames('/api/v1/contacts', 'a.b.c')).toEqual(['a'])
  })
})

describe('deals.aggregate takes the filter; the bag is not an aggregate field or a sort (D9, P4)', () => {
  it('counts only matching deals', async () => {
    const p = (await k.call(k.owner, 'POST', '/meta/v1/pipelines', { name: 'P' })).body.id
    const stage = (
      await k.call(k.owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: p,
        name: 'Open',
        kind: 'open',
        position: 1,
      })
    ).body.id
    for (const [name, bag] of [
      ['a', { tier: 'gold' }],
      ['b', { tier: 'gold' }],
      ['c', { tier: 'tin' }],
      ['d', {}],
    ] as const)
      await k.call(writer, 'POST', '/api/v1/deals', { name, stage_id: stage, additional_props: bag })
    const all = await k.call(writer, 'GET', '/api/v1/deals/aggregate')
    expect(all.body.count).toBe(4)
    const gold = await k.call(writer, 'GET', `/api/v1/deals/aggregate?${q('tier.eq.gold')}`)
    expect(gold.status, JSON.stringify(gold.body)).toBe(200)
    expect(gold.body.count).toBe(2)
    expect((await k.call(writer, 'GET', `/api/v1/deals/aggregate?${q('Bad.eq.1')}`)).status).toBe(400)
  })
  it('sort=additional_props, sum=additional_props and a q on a bag value find nothing or are refused (pins)', async () => {
    await seedContacts()
    const sort = await k.call(writer, 'GET', '/api/v1/contacts?sort=additional_props')
    expect(sort.status).toBe(400)
    const sum = await k.call(writer, 'GET', '/api/v1/deals/aggregate?sum=additional_props')
    expect(sum.status).toBe(400)
    const search = await k.call(writer, 'GET', '/api/v1/contacts?q=Paris')
    if (search.status === 200) expect(search.body.data).toEqual([])
    else expect(search.status).toBe(400)
  })
})

describe('filter discovery (D10)', () => {
  it('schema.get reports the bag filter unindexed, with a reason, on every object with a bag', async () => {
    const r = await k.call(writer, 'GET', '/meta/v1/schema')
    expect(r.status).toBe(200)
    const bagged = r.body.tables.filter((t: any) =>
      t.columns.some((c: any) => c.name === 'additional_props' && c.exposed),
    )
    expect(bagged.map((t: any) => t.name).sort()).toEqual(['companies', 'contacts', 'deals', 'tasks'])
    for (const t of bagged) {
      const f = t.resource.filters.find((x: any) => x.name === 'additional_props')
      expect(f, t.name).toBeDefined()
      expect(f.indexed, t.name).toBe(false)
      expect(f.description, t.name).toMatch(/reads every live row|no index/)
    }
  })
})

describe('the bag column in schema.get (D11, P6)', () => {
  it('is exposed and its description states the pattern, each limit, the merge patch, the filter and the property_keys read, on every built-in', async () => {
    const r = await k.call(writer, 'GET', '/meta/v1/schema')
    for (const name of ['contacts', 'companies', 'deals', 'tasks']) {
      const col = r.body.tables
        .find((t: any) => t.name === name)
        .columns.find((c: any) => c.name === 'additional_props')
      expect(col.exposed, name).toBe(true)
      for (const part of [
        BAG_KEY.source,
        String(BAG_LIMITS.string),
        String(BAG_LIMITS.keys),
        String(BAG_LIMITS.bytes),
        `${name}.property_keys`,
        'merge patch',
        'additional_props=',
      ])
        expect(col.description, `${name}: ${part}`).toContain(part)
    }
  })
})
