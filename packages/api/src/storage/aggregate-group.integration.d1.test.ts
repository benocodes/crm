import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compileOperation, uuidv7, type PreparedOperation } from '@vibase/storage'
import { createVibaseRegistry } from '../operations.js'
import { defineCustomObject } from '../custom/resource.js'
import type { TenantOperation } from '../registry.js'
import { ScopeSet } from '../scopes.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { PROJECTS_KEY, PROJECTS_REFS, createCustomTables } from '../test/custom-objects.js'
import { applyExtend } from '../test/extension-kit.js'
import { mintTestUserToken } from '../test/user-auth.js'

// [[CORE207]] D1-D8 on a real D1 and the real router: `group_by` on every aggregatable list, over REST and MCP (the CLI is in packages/cli). Expected answers are literals or the
// ungrouped call with the key added as filters (D4), never read from the implementation.
const OBJECT = PROJECTS_KEY
const extend = { contacts: { seats__c: { kind: 'integer' as const }, vip__c: { kind: 'boolean' as const } } }
const registry = createVibaseRegistry({ definitions: [defineCustomObject(OBJECT, PROJECTS_REFS)], extend })
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openActionKit({ registry })
  await createCustomTables(k.d1, OBJECT, PROJECTS_REFS)
  await applyExtend(k.d1, extend as never)
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.as(k.owner, registry.declaredScopes())
})
const path = (list: string) => `/api/v1/${list}`
const make = async (list: string, body: Record<string, unknown>) => {
  const r = await k.call(owner, 'POST', path(list), body)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}
const agg = (list: string, query = '', actor = owner) =>
  k.call(actor, 'GET', `${path(list)}/aggregate${query ? `?${query}` : ''}`)
const ok = async (list: string, query: string) => {
  const r = await agg(list, query)
  expect(r.status, `${list} ${query} ${JSON.stringify(r.body)}`).toBe(200)
  return r.body
}
const msg = (r: { body: any }) => String(r.body.error?.message ?? r.body.message ?? JSON.stringify(r.body))
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

/** Two stages and five deals: s1 has USD, USD, EUR and a deal with no currency; s2 has one USD deal; s3 has one deal with no amount. */
async function seedDeals() {
  const pipeline = (await k.call(owner, 'POST', '/meta/v1/pipelines', { name: 'Sales' })).body
  const stage = async (name: string, position: number) =>
    (
      await k.call(owner, 'POST', '/meta/v1/pipeline-stages', {
        pipeline_id: pipeline.id,
        name,
        kind: 'open',
        position,
      })
    ).body as { id: string }
  const s1 = await stage('One', 10)
  const s2 = await stage('Two', 20)
  const s3 = await stage('Three', 30)
  const deal = (stage_id: string, body: Record<string, unknown>) => make('deals', { stage_id, ...body })
  const d = [
    await deal(s1.id, { name: 'a', amount_minor: 100, currency: 'USD' }),
    await deal(s1.id, { name: 'b', amount_minor: 250, currency: 'USD' }),
    await deal(s1.id, { name: 'c', amount_minor: 400, currency: 'EUR' }),
    await deal(s1.id, { name: 'd' }),
    await deal(s2.id, { name: 'e', amount_minor: 900, currency: 'USD' }),
    await deal(s3.id, { name: 'f' }),
  ]
  return { s1, s2, s3, d }
}

describe('who groups on what (D1, D2): list x group-field kind', () => {
  it('deals group by a uuid (stage_id) and a text (currency) field; the key is the record form', async () => {
    const { s1, s2, s3 } = await seedDeals()
    const byStage = await ok('deals', 'group_by=stage_id')
    expect(byStage.count).toBe(6)
    expect(byStage.groups).toEqual(
      [s1, s2, s3]
        .map((s, i) => ({ key: { stage_id: s.id }, count: [4, 1, 1][i] }))
        .sort((a, b) => (a.key.stage_id < b.key.stage_id ? -1 : 1)),
    )
    const byCurrency = await ok('deals', 'group_by=currency')
    expect(byCurrency.groups).toEqual([
      { key: { currency: 'EUR' }, count: 1 },
      { key: { currency: 'USD' }, count: 3 },
      { key: { currency: null }, count: 2 },
    ])
  })
  it('tasks group by assignee_id (with a null group) and by status', async () => {
    await make('tasks', { title: 'a', assignee_id: owner.id })
    await make('tasks', { title: 'b', assignee_id: owner.id, status: 'done' })
    await make('tasks', { title: 'c' })
    expect((await ok('tasks', 'group_by=assignee_id')).groups).toEqual([
      { key: { assignee_id: owner.id }, count: 2 },
      { key: { assignee_id: null }, count: 1 },
    ])
    expect((await ok('tasks', 'status=eq.open&group_by=assignee_id')).groups).toEqual([
      { key: { assignee_id: owner.id }, count: 1 },
      { key: { assignee_id: null }, count: 1 },
    ])
    expect((await ok('tasks', 'group_by=status')).groups).toEqual([
      { key: { status: 'done' }, count: 1 },
      { key: { status: 'open' }, count: 2 },
    ])
  })
  it('contacts and companies group by a core text field', async () => {
    await make('contacts', { name: 'x' })
    await make('contacts', { name: 'x' })
    await make('contacts', { name: 'y' })
    expect(await ok('contacts', 'group_by=name')).toEqual({
      count: 3,
      groups: [
        { key: { name: 'x' }, count: 2 },
        { key: { name: 'y' }, count: 1 },
      ],
    })
    await make('companies', { name: 'Acme', domain: 'acme.com' })
    await make('companies', { name: 'Beta' })
    expect((await ok('companies', 'group_by=domain')).groups).toEqual([
      { key: { domain: 'acme.com' }, count: 1 },
      { key: { domain: null }, count: 1 },
    ])
  })
  it('an integer and a boolean __c field on a built-in group; the key is a number and true/false', async () => {
    await make('contacts', { name: 'a', seats__c: 3, vip__c: true })
    await make('contacts', { name: 'b', seats__c: 3, vip__c: false })
    await make('contacts', { name: 'c', seats__c: 10 })
    expect((await ok('contacts', 'group_by=seats__c')).groups).toEqual([
      { key: { seats__c: 3 }, count: 2 },
      { key: { seats__c: 10 }, count: 1 },
    ])
    expect((await ok('contacts', 'group_by=vip__c')).groups).toEqual([
      { key: { vip__c: false }, count: 1 },
      { key: { vip__c: true }, count: 1 },
      { key: { vip__c: null }, count: 1 },
    ])
  })
  it('a custom object groups by its enum, integer, boolean and reference fields', async () => {
    const co = await make('companies', { name: 'Acme' })
    await make(OBJECT, { name: 'a', stage: 'done', budget: 5, active: false, company: co.id })
    await make(OBJECT, { name: 'b', stage: 'done', budget: 5 })
    await make(OBJECT, { name: 'c', stage: 'planned' })
    expect((await ok(OBJECT, 'group_by=stage')).groups).toEqual([
      { key: { stage: 'done' }, count: 2 },
      { key: { stage: 'planned' }, count: 1 },
    ])
    expect((await ok(OBJECT, 'group_by=budget')).groups).toEqual([
      { key: { budget: 5 }, count: 2 },
      { key: { budget: null }, count: 1 },
    ])
    expect((await ok(OBJECT, 'group_by=active')).groups).toEqual([
      { key: { active: false }, count: 1 },
      { key: { active: true }, count: 2 },
    ])
    expect((await ok(OBJECT, 'group_by=company')).groups).toEqual([
      { key: { company: co.id }, count: 1 },
      { key: { company: null }, count: 2 },
    ])
  })
  it('MCP <list>_aggregate takes group_by on a built-in and on the custom object', async () => {
    await seedDeals()
    await make(OBJECT, { name: 'a', stage: 'done' })
    const tools = (await mcp('tools/list', {})).result.tools
    for (const [name, args, groups] of [
      ['deals_aggregate', { group_by: 'currency' }, 3],
      [`${OBJECT}_aggregate`, { group_by: 'stage' }, 1],
    ] as const) {
      expect(Object.keys(tools.find((t: any) => t.name === name).inputSchema.properties), name).toContain('group_by')
      const called = await mcp('tools/call', { name, arguments: args })
      expect(called.result.isError, JSON.stringify(called)).not.toBe(true)
      expect(called.result.structuredContent.groups, name).toHaveLength(groups)
    }
  })
  it.each([
    ['id', 'id'],
    ['created_at', 'timestamp'],
    ['closed_at', 'timestamp'],
    ['status', 'derived'],
    ['additional_props', 'additional_props'],
    ['city', 'unknown field city'],
    ['nothing', 'unknown field nothing'],
  ])('deals refuse group_by=%s with 400 naming it and the groupable list', async (field, why) => {
    const r = await agg('deals', `group_by=${field}`)
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error?.code ?? r.body.code).toBe('validation_error')
    expect(msg(r)).toContain(`group_by: `)
    expect(msg(r)).toContain(why)
    expect(msg(r)).toContain('group_by takes: ')
    expect(msg(r)).toContain('stage_id')
  })
  it('a timestamp is refused naming its kind, as the spec shows', async () => {
    const r = await agg('tasks', 'group_by=due_at')
    expect(r.status).toBe(400)
    expect(msg(r)).toContain('group_by: due_at is timestamp, not groupable; group_by takes: ')
  })
  it('403 without the list read scope, on each list', async () => {
    for (const list of ['deals', 'contacts', 'companies', 'tasks', OBJECT]) {
      const r = await agg(list, 'group_by=name', k.as(owner, ['tags:read']))
      expect(r.status, list).toBe(403)
    }
  })
})

describe('a group is the ungrouped answer (D4, D3)', () => {
  it('each group of stage_id,currency equals the ungrouped call with the key as filters; the top-level count is the sum of group counts', async () => {
    const { d } = await seedDeals()
    expect((await k.call(owner, 'DELETE', `/api/v1/deals/${d[1].id}`)).status).toBe(204)
    const fns = 'sum=amount_minor&avg=amount_minor&min=amount_minor,name&max=amount_minor,name'
    const grouped = await ok('deals', `group_by=stage_id,currency&${fns}`)
    const total = await ok('deals', '')
    expect(grouped.count).toBe(total.count)
    expect(grouped.count).toBe(5)
    expect(grouped.groups.reduce((n: number, g: any) => n + g.count, 0)).toBe(5)
    expect(grouped.sum).toBeUndefined()
    expect(grouped.currency).toBeUndefined()
    expect(grouped.groups.length).toBe(5)
    for (const g of grouped.groups) {
      const { stage_id, currency } = g.key
      const filters = `stage_id=eq.${stage_id}&currency=${currency === null ? 'is.null' : `eq.${currency}`}`
      const { count, sum, avg, min, max, currency: money } = await ok('deals', `${fns}&${filters}`)
      expect(g, JSON.stringify(g.key)).toEqual({ key: g.key, count, sum, avg, min, max, currency: money })
    }
  })
  it('without group_by the answer is the old one, with no groups key', async () => {
    await seedDeals()
    const r = await ok('deals', 'sum=amount_minor&currency=eq.USD')
    expect(r).toEqual({ count: 3, sum: { amount_minor: 1250 }, currency: { amount_minor: 'USD' } })
    expect(await ok('tasks', '')).toEqual({ count: 0 })
  })
  it('an empty result is count 0 and no groups', async () => {
    expect(await ok('deals', 'group_by=currency')).toEqual({ count: 0, groups: [] })
  })
  it('refuses a third field, a repeat, an empty term and an empty group_by', async () => {
    for (const [q, text] of [
      ['group_by=stage_id,currency,name', 'at most 2'],
      ['group_by=currency,currency', 'names currency twice'],
      ['group_by=currency,', 'empty term'],
      ['group_by=', 'at least one field'],
    ] as const) {
      const r = await agg('deals', q)
      expect(r.status, q).toBe(400)
      expect(msg(r), q).toContain(text)
    }
  })
  it('group_by plus 10 function terms is accepted: the group fields do not count', async () => {
    await seedDeals()
    const terms =
      'sum=amount_minor&avg=amount_minor&max=name&min=name,amount_minor,currency,expected_close_date,closed_at,created_at,updated_at'
    expect((await agg('deals', `${terms}&group_by=stage_id,currency&currency=eq.USD`)).status).toBe(200)
    expect((await agg('deals', `${terms},id&group_by=stage_id`)).status).toBe(400)
  })
  it('min and max over a group field are allowed', async () => {
    await seedDeals()
    const r = await ok('deals', 'group_by=currency&min=currency&max=name&currency=eq.USD')
    expect(r.groups).toEqual([{ key: { currency: 'USD' }, count: 3, min: { currency: 'USD' }, max: { name: 'e' } }])
  })
})

describe('order (D5)', () => {
  const rows = (...r: Array<Record<string, unknown>>) => Promise.all(r.map((b) => make(OBJECT, { name: 'n', ...b })))
  const keys = (b: any, f: string) => b.groups.map((g: any) => g.key[f])
  it('text is in byte order with the null group last, on the first and the second group field', async () => {
    await rows({ code: 'B' }, { code: 'a' }, {}, { code: 'c' })
    expect(keys(await ok(OBJECT, 'group_by=code'), 'code')).toEqual(['B', 'a', 'c', null])
    const second = await ok(OBJECT, 'group_by=active,code')
    expect(second.groups.map((g: any) => [g.key.active, g.key.code])).toEqual([
      [true, 'B'],
      [true, 'a'],
      [true, 'c'],
      [true, null],
    ])
  })
  it('integers are in numeric order with the null group last, on the first and the second group field', async () => {
    await rows({ budget: 10 }, { budget: 9 }, {}, { budget: 100 })
    expect(keys(await ok(OBJECT, 'group_by=budget'), 'budget')).toEqual([9, 10, 100, null])
    const second = await ok(OBJECT, 'group_by=active,budget')
    expect(second.groups.map((g: any) => g.key.budget)).toEqual([9, 10, 100, null])
  })
  it('false comes before true, on the first and the second group field', async () => {
    await rows({ active: true }, { active: false }, { active: true }, { active: false, stage: 'done' })
    expect(keys(await ok(OBJECT, 'group_by=active'), 'active')).toEqual([false, true])
    const second = await ok(OBJECT, 'group_by=stage,active')
    expect(second.groups.map((g: any) => [g.key.stage, g.key.active])).toEqual([
      ['done', false],
      ['planned', false],
      ['planned', true],
    ])
  })
  it('a null in the first field sorts last whatever the second field holds', async () => {
    await rows({ code: 'B', budget: 2 }, { code: 'B', budget: 1 }, { budget: 5 }, { code: 'a' })
    const r = await ok(OBJECT, 'group_by=code,budget')
    expect(r.groups.map((g: any) => [g.key.code, g.key.budget])).toEqual([
      ['B', 1],
      ['B', 2],
      ['a', null],
      [null, 5],
    ])
  })
})

describe('complete or refused (D6, #208)', () => {
  const seed = async (n: number) => {
    const at = '2026-01-01T00:00:00.000Z'
    const stmts = Array.from({ length: n }, (_, i) =>
      k.d1
        .prepare(
          `insert into "${OBJECT}" ("id", "organization_id", "created_by", "created_at", "updated_at", "name", "code") values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(uuidv7(), k.organizationId, owner.id, at, at, `n${i}`, `g${String(i).padStart(3, '0')}`),
    )
    await k.d1.batch(stmts)
  }
  it('200 groups answer all 200', async () => {
    await seed(200)
    const r = await ok(OBJECT, 'group_by=code')
    expect(r.count).toBe(200)
    expect(r.groups).toHaveLength(200)
  })
  it('201 groups is 400 with the fix, and a filter that brings it under 200 answers', async () => {
    await seed(201)
    const r = await agg(OBJECT, 'group_by=code')
    expect(r.status).toBe(400)
    expect(msg(r)).toBe(
      'group_by code gives more than 200 groups: add filters or group by a field with fewer values',
    )
    const filtered = await ok(OBJECT, 'group_by=code&code=lt.g100')
    expect(filtered.groups).toHaveLength(100)
    expect(filtered.count).toBe(100)
  })
  it('group fields count as one name in the message for two fields', async () => {
    await seed(201)
    const r = await agg(OBJECT, 'group_by=code,stage')
    expect(r.status).toBe(400)
    expect(msg(r)).toContain('group_by code,stage gives more than 200 groups')
  })
  it('a sum past the safe integer in one group refuses the call, naming the group; each group under it answers', async () => {
    const big = Number.MAX_SAFE_INTEGER
    await make(OBJECT, { name: 'a', budget: big, stage: 'planned' })
    await make(OBJECT, { name: 'b', budget: big, stage: 'done' })
    const fine = await ok(OBJECT, 'group_by=stage&sum=budget')
    expect(fine.groups.map((g: any) => g.sum.budget)).toEqual([big, big])
    await make(OBJECT, { name: 'c', budget: 1, stage: 'planned' })
    const r = await agg(OBJECT, 'group_by=stage&sum=budget')
    expect(r.status).toBe(400)
    expect(msg(r)).toContain('9007199254740991')
    expect(msg(r)).toContain('stage=planned')
  })
})

describe('money per group (D7)', () => {
  it('group_by=currency answers one total per currency, never refused, each with its own currency', async () => {
    await seedDeals()
    const r = await ok('deals', 'group_by=currency&sum=amount_minor')
    expect(r).toEqual({
      count: 6,
      groups: [
        { key: { currency: 'EUR' }, count: 1, sum: { amount_minor: 400 }, currency: { amount_minor: 'EUR' } },
        { key: { currency: 'USD' }, count: 3, sum: { amount_minor: 1250 }, currency: { amount_minor: 'USD' } },
        { key: { currency: null }, count: 2, sum: { amount_minor: null }, currency: { amount_minor: null } },
      ],
    })
  })
  it('a mixed-currency stage is refused naming the group, both currencies and the fix; the same data answers with currency in group_by or a currency filter', async () => {
    const { s1 } = await seedDeals()
    const r = await agg('deals', 'group_by=stage_id&sum=amount_minor')
    expect(r.status).toBe(400)
    expect(msg(r)).toContain(
      `amount_minor is in 2 currencies in group stage_id=${s1.id} (EUR, USD): add currency to group_by, or add currency=eq.<code>`,
    )
    expect((await agg('deals', 'group_by=stage_id,currency&sum=amount_minor')).status).toBe(200)
    const usd = await ok('deals', 'group_by=stage_id&sum=amount_minor&currency=eq.USD')
    expect(usd.groups.map((g: any) => g.currency.amount_minor)).toEqual(['USD', 'USD'])
  })
  it('two-field groups are named field=value, comma-joined, in the message', async () => {
    // currency in group_by cannot be mixed, so mix inside a (stage_id, name) group is impossible; name the group through two fields with a mixed pair
    const { s1 } = await seedDeals()
    await make('deals', { name: 'a', stage_id: s1.id, amount_minor: 1, currency: 'EUR' })
    const r = await agg('deals', 'group_by=stage_id,name&sum=amount_minor')
    expect(r.status).toBe(400)
    expect(msg(r)).toContain(`group stage_id=${s1.id},name=a (EUR, USD)`)
  })
  it('a stage whose amounts are all null carries currency null, not a refusal', async () => {
    const { s3 } = await seedDeals()
    const r = await ok('deals', `group_by=stage_id&sum=amount_minor&stage_id=eq.${s3.id}`)
    expect(r.groups).toEqual([
      { key: { stage_id: s3.id }, count: 1, sum: { amount_minor: null }, currency: { amount_minor: null } },
    ])
  })
})

describe('discovery, cost and compatibility (D8, D1)', () => {
  const GROUPABLE = ['uuid', 'text', 'integer', 'boolean']
  const lists = ['deals', 'contacts', 'companies', 'tasks', OBJECT]
  it('schema.get aggregate.group_by equals the rule over each list column filters, in record field order', async () => {
    const doc = (await k.call(owner, 'GET', '/meta/v1/schema')).body
    for (const list of lists) {
      const r = doc.tables.find((t: any) => t.name === list).resource
      const want = r.filters
        .filter((f: any) => !f.custom && f.name !== 'additional_props' && f.name !== 'id' && GROUPABLE.includes(f.kind))
        .map((f: any) => f.name)
      expect(r.aggregate.group_by, list).toEqual(want)
      expect(want.length, list).toBeGreaterThan(0)
    }
    const g = (n: string) => doc.tables.find((t: any) => t.name === n).resource.aggregate.group_by
    expect(g('deals')).toEqual(expect.arrayContaining(['stage_id', 'currency']))
    expect(g('deals')).not.toContain('status')
    expect(g('deals')).not.toContain('created_at')
    expect(g('contacts')).toEqual(expect.arrayContaining(['seats__c', 'vip__c']))
    expect(g(OBJECT)).toEqual(expect.arrayContaining(['stage', 'budget', 'active', 'company']))
    expect(g(OBJECT)).not.toContain('id')
  })
  it('OpenAPI describes group_by with the groupable fields; the answer is an object; every aggregate MCP tool has an outputSchema', async () => {
    const doc = (await k.call(owner, 'GET', '/api/v1/openapi.json')).body
    for (const list of lists) {
      const op = doc.paths[`/api/v1/${list}/aggregate`].get
      const p = op.parameters.find((x: any) => x.name === 'group_by')
      expect(p, list).toBeDefined()
      expect(p.description).toContain('stage')
      expect(op.description).toContain('groups')
    }
    const deals = doc.paths['/api/v1/deals/aggregate'].get.parameters.find((x: any) => x.name === 'group_by')
    expect(deals.description).toContain('stage_id')
    expect(deals.description).not.toContain('created_at')
    const resp = doc.paths['/api/v1/deals/aggregate'].get.responses['200'].content['application/json'].schema
    expect(resp.type ?? resp.$ref ?? resp.allOf).toBeDefined()
    const tools = (await mcp('tools/list', {})).result.tools.filter((t: any) => t.name.endsWith('_aggregate'))
    expect(tools.length).toBe(lists.length)
    for (const t of tools) {
      expect(t.outputSchema?.type, t.name).toBe('object')
      expect(Object.keys(t.outputSchema.properties), t.name).toContain('groups')
    }
  })
  it('the cost sentence states the sort by group fields and names no index', () => {
    for (const list of lists) {
      const d = registry.get(`${list}.aggregate`)!.description
      expect(d).toContain('sorted by the group fields')
      expect(d).not.toMatch(/idx_|_idx\b/)
    }
  })
  let e: Engine
  beforeAll(async () => {
    e = await openD1Engine()
    await createCustomTables(e.d1!, OBJECT, PROJECTS_REFS)
  })
  afterAll(async () => {
    await e?.close()
  })
  it('the plan of a grouped call reads the table as the ungrouped call does', async () => {
    const plan = async (list: string, query: Record<string, unknown>) => {
      const op = registry.get(`${list}.aggregate`) as TenantOperation
      const env = e.env({ scopes: ScopeSet.parse(registry.declaredScopes()) })
      const compiled = compileOperation(
        (await op.prepare(env as never, { query, params: {}, body: undefined })) as PreparedOperation<unknown>,
        'd1',
      )
      const read = compiled.reads[0]!
      const rows = (
        await e
          .d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
          .bind(...read.parameters)
          .all()
      ).results as Array<{ detail: string }>
      return rows.map((r) => r.detail).filter((d) => /^(SEARCH|SCAN) /.test(d))
    }
    for (const [list, group] of [
      ['deals', 'stage_id'],
      ['contacts', 'name'],
      ['companies', 'domain'],
      ['tasks', 'assignee_id'],
      [OBJECT, 'stage'],
    ] as const)
      expect(await plan(list, { group_by: group }), list).toEqual(await plan(list, {}))
  })
})
