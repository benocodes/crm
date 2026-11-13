import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// [[CORE202]] D13, D14, D15 on the D1 app over REST: the operation's contract, the functions by kind (a matrix), and the money rule.
const FULL = ['deals:read', 'deals:write', 'pipelines:read', 'pipelines:write', 'tags:read', 'tags:write', 'associations:read', 'associations:write']
const MAX = 9007199254740991
let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVibaseRegistry())
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], method: string, path: string, body?: unknown) => {
  const res = await s.call(t, 'agent', scopes, method, path, body)
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}
const must = async (method: string, path: string, body?: unknown, scopes = FULL) => {
  const r = await call(scopes, method, path, body)
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300)
  return r.body
}
const aggregate = (query: string, scopes = FULL) => call(scopes, 'GET', `/api/v1/deals/aggregate?${query}`)
const ok = async (query: string, scopes = FULL) => {
  const r = await aggregate(query, scopes)
  expect(r.status, `${query} ${JSON.stringify(r.body)}`).toBe(200)
  return r.body
}
const refused = async (query: string, scopes = FULL) => {
  const r = await aggregate(query, scopes)
  return r
}

/**
 * A: Acme, 600000 USD, closes 2026-11-01, closed_at 2026-11-01T00:00Z      B: Beta, 400001 USD, closes 2026-12-15
 * C: Gamma, 700000 EUR                                                      D: Delta, no amount, closes 2026-10-20
 * E: Echo, currency GBP and no amount                                       tag consultancy on A and B
 */
async function seed() {
  const p = await must('POST', '/meta/v1/pipelines', { name: 'Sales' })
  const open = await must('POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Open', kind: 'open', position: 10 })
  const make = async (body: Record<string, unknown>) => (await must('POST', '/api/v1/deals', { stage_id: open.id, ...body })) as { id: string }
  const direct = async (row: Record<string, unknown>) => (await s.insert(t, 'deals', { pipeline_id: p.id, stage_id: open.id, ...row })) as { id: string }
  const A = await direct({ name: 'Acme', amount_minor: 600000, currency: 'USD', expected_close_date: '2026-11-01', closed_at: '2026-11-01T00:00:00.000Z' })
  const B = await make({ name: 'Beta', amount_minor: 400001, currency: 'USD', expected_close_date: '2026-12-15' })
  const C = await make({ name: 'Gamma', amount_minor: 700000, currency: 'EUR' })
  const D = await make({ name: 'Delta', expected_close_date: '2026-10-20' })
  const E = await direct({ name: 'Echo', currency: 'GBP' })
  const tag = await must('POST', '/api/v1/tags', { name: 'consultancy' })
  for (const d of [A, B]) await must('POST', '/api/v1/associations', { a_type: 'deals', a_id: d.id, b_type: 'tags', b_id: tag.id })
  return { p, open, A, B, C, D, E, tag }
}

describe('operation contract (D13)', () => {
  const pageAll = async (query: string) => {
    const ids: string[] = []
    let after: string | null = null
    do {
      const r = await call(FULL, 'GET', `/api/v1/deals?limit=2${query ? `&${query}` : ''}${after ? `&after=${after}` : ''}`)
      expect(r.status).toBe(200)
      ids.push(...r.body.data.map((d: any) => d.id))
      after = r.body.next_cursor
    } while (after)
    return ids.length
  }
  it('count equals the rows deals.list returns for the same filters, paged to the end (4 filter sets)', async () => {
    await seed()
    for (const [query, expected] of [['', 5], ['amount_minor=gt.500000', 2], ['tag=consultancy&amount_minor=gt.0', 2], ['name=eq.nothing', 0]] as const) {
      const listed = await pageAll(query)
      expect(listed, query).toBe(expected)
      expect((await ok(query)).count, query).toBe(listed)
    }
  })
  it('a call with no function answers the count alone, with no function or currency key', async () => {
    await seed()
    expect(await ok('')).toEqual({ count: 5 })
  })
  it('soft-deleted deals are not counted', async () => {
    const { C } = await seed()
    expect((await ok('')).count).toBe(5)
    expect((await call(FULL, 'DELETE', `/api/v1/deals/${C.id}`)).status).toBe(204)
    expect((await ok('')).count).toBe(4)
  })
  it('needs deals:read (403 insufficient_scope) and, for the tag filter, tags:read as the list does', async () => {
    await seed()
    const none = await refused('', ['tasks:read'])
    expect([none.status, none.body.error.code]).toEqual([403, 'insufficient_scope'])
    const tag = await refused('tag=consultancy', ['deals:read', 'associations:read'])
    expect([tag.status, tag.body.error.code, tag.body.error.message]).toEqual([403, 'insufficient_scope', 'requires tags:read to filter deals by tag'])
  })
  it('after, limit, sort and order are refused, and so is an unknown filter', async () => {
    await seed()
    for (const q of ['limit=5', 'after=0190b2c4-0000-7000-8000-00000000dead', 'sort=created_at', 'order=desc', 'nope=1']) {
      const r = await refused(q)
      expect([r.status, r.body.error.code], q).toEqual([400, 'validation_error'])
    }
    expect((await refused('limit=5')).body.error.message).toBe('after, limit, sort and order are not parameters of an aggregate')
    expect((await refused('nope=1')).body.error.message).toBe('unknown filter: nope')
  })
  it('more than 10 terms is a 400', async () => {
    await seed()
    const r = await refused('min=name,amount_minor,currency,expected_close_date,closed_at,created_at&max=closed_at,created_at,updated_at&sum=amount_minor&avg=amount_minor&currency=eq.USD')
    expect([r.status, r.body.error.code]).toEqual([400, 'validation_error'])
  })
  it('GET /deals/aggregate is not captured by GET /deals/{id}, which still answers a real id and a 404 for a stranger', async () => {
    const { A } = await seed()
    expect((await aggregate('')).status).toBe(200)
    expect((await call(FULL, 'GET', `/api/v1/deals/${A.id}`)).body.id).toBe(A.id)
    expect((await call(FULL, 'GET', '/api/v1/deals/0190b2c4-0000-7000-8000-00000000dead')).status).toBe(404)
  })
  it('writes no event and no row', async () => {
    await seed()
    const events = await s.countEvents()
    const rows = await s.countRows('deals')
    await ok('sum=amount_minor&currency=eq.USD')
    await refused('sum=amount_minor')
    expect([await s.countEvents(), await s.countRows('deals')]).toEqual([events, rows])
  })
  it('a list that has not opted in has no aggregate operation or route', async () => {
    const registry = createVibaseRegistry()
    expect(registry.get('deals.aggregate')).toBeDefined()
    expect(registry.operations().filter((o) => o.name.endsWith('.aggregate')).map((o) => o.name)).toEqual(['deals.aggregate'])
    const doc = (await (await s.call(t, 'agent', FULL, 'GET', '/api/v1/openapi.json')).json()) as any
    expect(Object.keys(doc.paths).filter((p) => p.endsWith('/aggregate'))).toEqual(['/api/v1/deals/aggregate'])
    expect((await call([...FULL, 'contacts:read'], 'GET', '/api/v1/contacts/aggregate')).status).toBe(404)
  })
})

describe('functions by kind (D14)', () => {
  const USD = 'currency=eq.USD'
  // integer: amount_minor over the USD deals (600000, 400001); timestamp: closed_at (A only); text: name and expected_close_date.
  const allowed: Array<[string, string, string, unknown]> = [
    ['sum', 'amount_minor', USD, 1000001],
    ['avg', 'amount_minor', USD, 500000.5],
    ['min', 'amount_minor', USD, 400001],
    ['max', 'amount_minor', USD, 600000],
    ['min', 'closed_at', '', '2026-11-01T00:00:00.000Z'],
    ['max', 'closed_at', '', '2026-11-01T00:00:00.000Z'],
    ['min', 'name', '', 'Acme'],
    ['max', 'name', '', 'Gamma'],
    ['min', 'expected_close_date', '', '2026-10-20'],
    ['max', 'expected_close_date', '', '2026-12-15'],
  ]
  it.each(allowed)('%s of %s returns the SQL answer in record form', async (fn, field, extra, expected) => {
    await seed()
    const body = await ok(`${fn}=${field}${extra ? `&${extra}` : ''}`)
    expect(body[fn]).toEqual({ [field]: expected })
    expect(Object.keys(body).filter((k) => ['sum', 'avg', 'min', 'max'].includes(k))).toEqual([fn])
  })
  const refusedPairs: Array<[string, string, string]> = [
    ['sum', 'closed_at', 'sum takes: amount_minor'],
    ['sum', 'name', 'sum takes: amount_minor'],
    ['sum', 'owner_id', 'sum takes: amount_minor'],
    ['sum', 'status', 'sum takes: amount_minor'],
    ['avg', 'expected_close_date', 'avg takes: amount_minor'],
    ['avg', 'stage_id', 'avg takes: amount_minor'],
    ['min', 'owner_id', 'min takes: name, amount_minor, currency, expected_close_date, closed_at, created_at, updated_at'],
    ['max', 'pipeline_id', 'max takes: name, amount_minor, currency, expected_close_date, closed_at, created_at, updated_at'],
    ['max', 'status', 'max takes: name, amount_minor, currency, expected_close_date, closed_at, created_at, updated_at'],
    ['max', 'nope', 'max takes: name, amount_minor'],
  ]
  it.each(refusedPairs)('%s of %s is a 400 naming the allowed fields', async (fn, field, takes) => {
    await seed()
    const r = await refused(`${fn}=${field}`)
    expect([r.status, r.body.error.code]).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain(takes)
  })
  it('nulls are ignored: an average over a null amount is over the rest, and a min over nothing but nulls is null, not 0', async () => {
    await seed()
    expect((await ok(`avg=amount_minor&${USD}&amount_minor=not.is.null`)).avg).toEqual({ amount_minor: 500000.5 })
    const none = await ok('amount_minor=is.null&min=amount_minor&max=closed_at&sum=amount_minor&avg=amount_minor')
    expect(none).toMatchObject({ count: 2, sum: { amount_minor: null }, avg: { amount_minor: null }, min: { amount_minor: null }, max: { closed_at: null } })
  })
  it('a sum past Number.MAX_SAFE_INTEGER is a 400 naming the limit, not a rounded number; the same amounts still have a min, max and avg', async () => {
    const p = await must('POST', '/meta/v1/pipelines', { name: 'P' })
    const st = await must('POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Open', kind: 'open', position: 1 })
    for (const name of ['x', 'y']) await s.insert(t, 'deals', { pipeline_id: p.id, stage_id: st.id, name, amount_minor: MAX, currency: 'USD' })
    const r = await refused('sum=amount_minor')
    expect([r.status, r.body.error.code]).toEqual([400, 'validation_error'])
    expect(r.body.error.message).toContain(String(MAX))
    expect(r.body.error.message).toContain('sum of amount_minor')
    expect((await ok('max=amount_minor&min=amount_minor')).max).toEqual({ amount_minor: MAX })
    expect(await ok('sum=amount_minor&amount_minor=lte.0')).toMatchObject({ count: 0 })
    // exactly the limit is exact and allowed
    await s.insert(t, 'deals', { pipeline_id: p.id, stage_id: st.id, name: 'z', amount_minor: 0, currency: 'USD' })
    expect((await ok('sum=amount_minor&name=eq.z')).sum).toEqual({ amount_minor: 0 })
  })
})

describe('money rule (D15)', () => {
  const mixed = 'amount_minor is in 2 currencies here (EUR, USD): add currency=eq.<code> to aggregate one'
  it.each(['sum', 'avg', 'min', 'max'])('%s of amount_minor over EUR and USD amounts is a 400 with the exact message', async (fn) => {
    await seed()
    const r = await refused(`${fn}=amount_minor`)
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([400, 'validation_error', mixed])
  })
  it('count alone and a non-money field still answer on the mixed set, with no currency key', async () => {
    await seed()
    expect(await ok('')).toEqual({ count: 5 })
    expect(await ok('max=name')).toEqual({ count: 5, max: { name: 'Gamma' } })
    expect(await ok('min=expected_close_date&max=closed_at')).not.toHaveProperty('currency')
  })
  it('with one currency the answer carries it, beside the figures', async () => {
    await seed()
    expect(await ok('sum=amount_minor&max=amount_minor&currency=eq.USD')).toEqual({ count: 2, sum: { amount_minor: 1000001 }, max: { amount_minor: 600000 }, currency: { amount_minor: 'USD' } })
  })
  it('a deal with a currency but no amount does not make the set mixed', async () => {
    await seed()
    expect(await ok('sum=amount_minor&currency=in.(USD,GBP)')).toEqual({ count: 3, sum: { amount_minor: 1000001 }, currency: { amount_minor: 'USD' } })
  })
  it('empty state: no matching deals, and matching deals with only null amounts, give null figures and a null currency, not a refusal', async () => {
    await seed()
    expect(await ok('name=eq.nothing&sum=amount_minor')).toEqual({ count: 0, sum: { amount_minor: null }, currency: { amount_minor: null } })
    expect(await ok('amount_minor=is.null&sum=amount_minor')).toEqual({ count: 2, sum: { amount_minor: null }, currency: { amount_minor: null } })
    expect(await ok('currency=eq.GBP&max=amount_minor')).toEqual({ count: 1, max: { amount_minor: null }, currency: { amount_minor: null } })
  })
  it('the tag filter composes with the money rule', async () => {
    await seed()
    expect(await ok('tag=consultancy&sum=amount_minor')).toEqual({ count: 2, sum: { amount_minor: 1000001 }, currency: { amount_minor: 'USD' } })
  })
})
