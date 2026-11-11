import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { operatorsFor } from '../storage/column-filters.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// [[CORE200]] on the D1 app over REST: the column filter grammar on deals (operator x kind, patterns, money), tag by name, surfaces and paging.
const FULL = ['deals:read', 'deals:write', 'pipelines:read', 'pipelines:write', 'tags:read', 'tags:write', 'associations:read', 'associations:write']
let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVaultRegistry())
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
const names = (r: { body: any }) => r.body.data.map((d: any) => d.name).sort() as string[]
const list = async (query: string, scopes = FULL) => {
  const r = await call(scopes, 'GET', `/api/v1/deals?${query}`)
  expect(r.status, `${query} ${JSON.stringify(r.body)}`).toBe(200)
  return names(r)
}

/**
 * A: 600000 USD, closes 2026-11-01, owner P, closed_at 2026-11-01T00:00Z      B: 400000 USD, closes 2026-12-15, name has % and _
 * C: 700000 EUR, no date                                                       D: no amount, closes 2026-10-20, name 'acme renewal'
 * E: no amount, in a won stage (closed), closed_at 2026-11-01T01:00Z, 'José'   F: 'Betaz100zz' (what an unescaped % and _ would also match)
 */
async function seed() {
  const p = await must('POST', '/meta/v1/pipelines', { name: 'Sales' })
  const open = await must('POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Open', kind: 'open', position: 10 })
  const won = await must('POST', '/meta/v1/pipeline-stages', { pipeline_id: p.id, name: 'Won', kind: 'won', position: 90 })
  const P = await s.principalId(t, 'agent', FULL)
  const make = async (body: Record<string, unknown>) => (await must('POST', '/api/v1/deals', { stage_id: open.id, ...body })) as { id: string; name: string }
  // A and E are inserted directly: their closed_at is a chosen instant, which the API never takes.
  const direct = async (row: Record<string, unknown>) => (await s.insert(t, 'deals', { pipeline_id: p.id, ...row })) as { id: string; name: string }
  const A = await direct({ name: 'Acme pilot', stage_id: open.id, amount_minor: 600000, currency: 'USD', expected_close_date: '2026-11-01', owner_id: P, closed_at: '2026-11-01T00:00:00.000Z' })
  const B = await make({ name: 'Beta_100%', amount_minor: 400000, currency: 'USD', expected_close_date: '2026-12-15' })
  const C = await make({ name: 'Gamma', amount_minor: 700000, currency: 'EUR' })
  const D = await make({ name: 'acme renewal', expected_close_date: '2026-10-20' })
  const E = await direct({ name: 'José', stage_id: won.id, closed_at: '2026-11-01T01:00:00.000Z' })
  const F = await make({ name: 'Betaz100zz' })
  return { p, open, won, P, A, B, C, D, E, F }
}

describe('operator x kind on deals (D3, D8)', () => {
  const cases: Array<[string, string[]]> = [
    // integer, nullable: amount_minor (A 600000, B 400000, C 700000; D E F null)
    ['amount_minor=gt.500000', ['Acme pilot', 'Gamma']],
    ['amount_minor=gte.600000', ['Acme pilot', 'Gamma']],
    ['amount_minor=lt.600000', ['Beta_100%']],
    ['amount_minor=lte.600000', ['Acme pilot', 'Beta_100%']],
    ['amount_minor=eq.400000', ['Beta_100%']],
    ['amount_minor=400000', ['Beta_100%']],
    ['amount_minor=neq.600000', ['Beta_100%', 'Gamma']],
    ['amount_minor=not.gt.500000', ['Beta_100%']],
    ['amount_minor=not.eq.400000', ['Acme pilot', 'Gamma']],
    ['amount_minor=in.(400000,700000)', ['Beta_100%', 'Gamma']],
    ['amount_minor=not.in.(400000)', ['Acme pilot', 'Gamma']],
    ['amount_minor=is.null', ['Betaz100zz', 'José', 'acme renewal']],
    ['amount_minor=not.is.null', ['Acme pilot', 'Beta_100%', 'Gamma']],
    // text, nullable: currency (A B USD, C EUR)
    ['currency=eq.usd', ['Acme pilot', 'Beta_100%']],
    ['currency=usd', ['Acme pilot', 'Beta_100%']],
    ['currency=in.(usd,eur)', ['Acme pilot', 'Beta_100%', 'Gamma']],
    ['currency=neq.usd', ['Gamma']],
    ['currency=gt.EUR', ['Acme pilot', 'Beta_100%']],
    ['currency=ilike.us*', ['Acme pilot', 'Beta_100%']],
    ['currency=like.US*', ['Acme pilot', 'Beta_100%']],
    ['currency=like.us*', []],
    ['currency=is.null', ['Betaz100zz', 'José', 'acme renewal']],
    // text by byte order on an ISO date: expected_close_date (A 2026-11-01, B 2026-12-15, D 2026-10-20)
    ['expected_close_date=gte.2026-11-01', ['Acme pilot', 'Beta_100%']],
    ['expected_close_date=lt.2026-11-01', ['acme renewal']],
    ['expected_close_date=neq.2026-11-01', ['Beta_100%', 'acme renewal']],
    ['expected_close_date=is.null', ['Betaz100zz', 'Gamma', 'José']],
    ['expected_close_date=not.is.null', ['Acme pilot', 'Beta_100%', 'acme renewal']],
    // text, NOT NULL: name
    ['name=eq.Gamma', ['Gamma']],
    ['name=neq.Gamma', ['Acme pilot', 'Beta_100%', 'Betaz100zz', 'José', 'acme renewal']],
    ['name=in.("Beta_100%",Gamma)', ['Beta_100%', 'Gamma']],
    ['name=gt.Gamma', ['José', 'acme renewal']],
    // uuid, nullable: owner_id (A only); the nulls are excluded by neq and in
    ['owner_id=not.is.null', ['Acme pilot']],
    ['owner_id=is.null', ['Beta_100%', 'Betaz100zz', 'Gamma', 'José', 'acme renewal']],
    // timestamp, nullable: closed_at (A 00:00Z, E 01:00Z on 2026-11-01)
    ['closed_at=is.null', ['Beta_100%', 'Betaz100zz', 'Gamma', 'acme renewal']],
    ['closed_at=gte.2026-11-01', ['Acme pilot', 'José']],
    ['closed_at=gt.2026-11-01', ['José']],
    ['closed_at=eq.2026-11-01T02:00:00%2B01:00', ['José']],
    ['closed_at=lt.2026-11-01T00:00:01Z', ['Acme pilot']],
    ['closed_at=in.(2026-11-01,2026-11-01T01:00:00Z)', ['Acme pilot', 'José']],
    ['closed_at=neq.2026-11-01', ['José']],
    // timestamp, NOT NULL
    ['created_at=gt.2000-01-01', ['Acme pilot', 'Beta_100%', 'Betaz100zz', 'Gamma', 'José', 'acme renewal']],
    ['created_at=lt.2000-01-01', []],
    // the pass query's shape: a comparison across two currencies needs no currency filter
    ['amount_minor=gt.500000&currency=eq.USD', ['Acme pilot']],
  ]
  it.each(cases)('%s', async (query, expected) => {
    await seed()
    expect(await list(query)).toEqual(expected)
  })

  it('owner_id: eq, neq and in compare with the stored uuid; neq and in exclude the null owners', async () => {
    const { P } = await seed()
    expect(await list(`owner_id=eq.${P}`)).toEqual(['Acme pilot'])
    expect(await list(`owner_id=${P.toUpperCase()}`)).toEqual(['Acme pilot'])
    expect(await list(`owner_id=neq.${P}`)).toEqual([])
    expect(await list(`owner_id=in.(${P})`)).toEqual(['Acme pilot'])
    expect(await list(`owner_id=not.in.(${P})`)).toEqual([])
  })

  it('the existing equality filters (a bare UUID) behave as before, and a bad UUID is still a 400', async () => {
    const { p, open, won } = await seed()
    expect((await list(`pipeline_id=${p.id}`)).length).toBe(6)
    expect(await list(`stage_id=${won.id}`)).toEqual(['José'])
    expect(await list(`stage_id=in.(${won.id},${open.id})&status=won`)).toEqual(['José'])
    const bad = await call(FULL, 'GET', '/api/v1/deals?pipeline_id=not-a-uuid')
    expect([bad.status, bad.body.error.code, bad.body.error.message]).toEqual([400, 'validation_error', 'filter pipeline_id: "not-a-uuid" is not a UUID'])
  })

  it('one refused operator per kind is a 400 listing the operators that are available', async () => {
    await seed()
    const refusal = async (query: string) => {
      const r = await call(FULL, 'GET', `/api/v1/deals?${query}`)
      expect([r.status, r.body.error.code]).toEqual([400, 'validation_error'])
      return r.body.error.message as string
    }
    expect(await refusal('amount_minor=like.5*')).toBe('filter amount_minor: like is not available for integer (available: eq, neq, gt, gte, lt, lte, in, is)')
    expect(await refusal('owner_id=gt.x')).toBe('filter owner_id: gt is not available for uuid (available: eq, neq, in, is)')
    expect(await refusal('closed_at=like.2026*')).toBe('filter closed_at: like is not available for timestamp (available: eq, neq, gt, gte, lt, lte, in, is)')
    expect(await refusal('name=is.null')).toBe('filter name: is is not available for text (available: eq, neq, gt, gte, lt, lte, in, like, ilike)')
    expect(await refusal('created_at=is.null')).toBe('filter created_at: is is not available for timestamp (available: eq, neq, gt, gte, lt, lte, in)')
    expect(await refusal('amount_minor=gt.lots')).toBe('filter amount_minor: "lots" is not a safe integer')
    expect(await refusal('amount_minor=not.')).toBe('filter amount_minor: not. needs an operator after it, as in not.eq.x')
    expect(await refusal('organization_id=eq.x')).toBe('unknown filter: organization_id')
    expect(await refusal('nonsense=1')).toBe('unknown filter: nonsense')
  })

  it('a repeated parameter is still a 400 and a pattern is limited to 200 characters', async () => {
    await seed()
    const twice = await call(FULL, 'GET', '/api/v1/deals?amount_minor=gt.1&amount_minor=lt.5')
    expect([twice.status, twice.body.error.code]).toEqual([400, 'validation_error'])
    const long = await call(FULL, 'GET', `/api/v1/deals?name=ilike.${'a'.repeat(201)}`)
    expect(long.body.error.message).toBe('filter name: a pattern is at most 200 characters')
  })

  it('a missing read scope is still 403 before any grammar is read', async () => {
    const r = await call(['pipelines:read'], 'GET', '/api/v1/deals?amount_minor=nonsense')
    expect(r.status).toBe(403)
  })
})

describe('patterns (D4)', () => {
  it('ilike matches across ASCII case, like does not', async () => {
    await seed()
    expect(await list('name=ilike.*ACME*')).toEqual(['Acme pilot', 'acme renewal'])
    expect(await list('name=like.*acme*')).toEqual(['acme renewal'])
    expect(await list('name=like.Acme*')).toEqual(['Acme pilot'])
    expect(await list('name=not.ilike.*acme*')).toEqual(['Beta_100%', 'Betaz100zz', 'Gamma', 'José'])
  })
  it('a name containing % or _ matches only itself; * is the only wildcard', async () => {
    await seed()
    expect(await list('name=ilike.beta_100%25')).toEqual(['Beta_100%'])
    expect(await list('name=like.Beta_100%25')).toEqual(['Beta_100%'])
    expect(await list('name=ilike.*beta_100%25*')).toEqual(['Beta_100%'])
    expect(await list('name=ilike.beta*')).toEqual(['Beta_100%', 'Betaz100zz'])
    expect(await list('name=like.Gam?a')).toEqual([])
  })
  it('ilike is ASCII only: jose does not match José (the stated limit)', async () => {
    await seed()
    expect(await list('name=ilike.*jose*')).toEqual([])
    expect(await list('name=ilike.*jos*')).toEqual(['José'])
  })
})

describe('tag by name (D7)', () => {
  const tagged = async () => {
    const seeded = await seed()
    const tag = await must('POST', '/api/v1/tags', { name: 'consultancy' })
    const link = async (deal: { id: string }, tagId = tag.id) => (await must('POST', '/api/v1/associations', { a_type: 'deals', a_id: deal.id, b_type: 'tags', b_id: tagId })) as { id: string }
    const edgeA = await link(seeded.A)
    await link(seeded.B)
    await link(seeded.C)
    return { ...seeded, tag, link, edgeA }
  }
  it('the pass query returns exactly the expected deals, and each part narrows', async () => {
    await tagged()
    expect(await list('amount_minor=gt.500000&currency=eq.USD&tag=consultancy')).toEqual(['Acme pilot'])
    expect(await list('tag=consultancy')).toEqual(['Acme pilot', 'Beta_100%', 'Gamma'])
    expect(await list('amount_minor=gt.500000&tag=consultancy')).toEqual(['Acme pilot', 'Gamma'])
  })
  it('matches the exact name, trimmed; not a differently-cased name; an unknown name is an empty page', async () => {
    await tagged()
    expect(await list('tag=%20consultancy%20')).toEqual(['Acme pilot', 'Beta_100%', 'Gamma'])
    expect(await list('tag=Consultancy')).toEqual([])
    expect(await list('tag=consult')).toEqual([])
    expect(await list('tag=no-such-tag')).toEqual([])
  })
  it('a deleted tag and a removed association do not match; the tag_id filter still works', async () => {
    const { tag, edgeA, B } = await tagged()
    expect((await call(FULL, 'DELETE', `/api/v1/associations/${edgeA.id}`)).status).toBe(204)
    expect(await list('tag=consultancy')).toEqual(['Beta_100%', 'Gamma'])
    expect(await list(`tag_id=${tag.id}`)).toEqual(['Beta_100%', 'Gamma'])
    // A deleted tag that still has a live edge (the API's cascade would have removed it, so the rows are inserted): its name matches nothing.
    const ghost = await s.insert(t, 'tags', { name: 'ghost', deleted_at: '2026-11-02T00:00:00.000Z' })
    await s.insert(t, 'associations', { a_type: 'deals', a_id: B.id, b_type: 'tags', b_id: ghost.id })
    expect(await list('tag=ghost')).toEqual([])
    expect(await list('tag=consultancy')).toEqual(['Beta_100%', 'Gamma'])
  })
  it('a live tag of the name is found even when an older tag of that name was deleted', async () => {
    const { A, tag } = await tagged()
    expect((await call(FULL, 'DELETE', `/api/v1/tags/${tag.id}`)).status).toBe(204)
    expect(await list('tag=consultancy')).toEqual([])
    const again = await must('POST', '/api/v1/tags', { name: 'consultancy' })
    await must('POST', '/api/v1/associations', { a_type: 'deals', a_id: A.id, b_type: 'tags', b_id: again.id })
    expect(await list('tag=consultancy')).toEqual(['Acme pilot'])
  })
  it('needs tags:read and associations:read: 403 insufficient_scope naming the scope', async () => {
    await tagged()
    for (const missing of ['tags:read', 'associations:read']) {
      const r = await call(FULL.filter((x) => x !== missing), 'GET', '/api/v1/deals?tag=consultancy')
      expect([r.status, r.body.error.code]).toEqual([403, 'insufficient_scope'])
      expect(r.body.error.message).toContain(missing)
      expect((await call(FULL.filter((x) => x !== missing), 'GET', '/api/v1/deals')).status).toBe(200)
    }
  })
  it('an empty tag name is a 400', async () => {
    await tagged()
    const r = await call(FULL, 'GET', '/api/v1/deals?tag=%20')
    expect([r.status, r.body.error.code]).toEqual([400, 'validation_error'])
  })
})

describe('surfaces (D9)', () => {
  it('each column filter is one string parameter described from the operator table; custom filters are as before', async () => {
    await seed()
    const doc = (await (await s.call(t, 'agent', FULL, 'GET', '/api/v1/openapi.json')).json()) as any
    const params = Object.fromEntries((doc.paths['/api/v1/deals'].get.parameters as any[]).map((p) => [p.name, p]))
    const column: Array<[string, 'uuid' | 'text' | 'integer' | 'timestamp', boolean]> = [
      ['id', 'uuid', false], ['name', 'text', false], ['pipeline_id', 'uuid', false], ['stage_id', 'uuid', false], ['amount_minor', 'integer', true],
      ['currency', 'text', true], ['expected_close_date', 'text', true], ['owner_id', 'uuid', true], ['closed_at', 'timestamp', true],
      ['created_by', 'uuid', false], ['created_at', 'timestamp', false], ['updated_at', 'timestamp', false],
    ]
    for (const [name, kind, nullable] of column) {
      expect(params[name], name).toBeDefined()
      expect(params[name].schema.type, name).toBe('string')
      expect(params[name].schema.format, name).toBeUndefined()
      const description = params[name].schema.description ?? params[name].description
      expect(description, name).toContain(`Operators: ${operatorsFor(kind, nullable).join(', ')}.`)
      expect(description, name).toContain(kind)
    }
    expect(params.amount_minor.schema.description ?? params.amount_minor.description).toContain('currency=eq.USD')
    expect(params.organization_id).toBeUndefined()
    for (const custom of ['tag_id', 'company_id', 'contact_id']) expect(params[custom].schema.format).toBe('uuid')
    expect(params.tag.schema.type).toBe('string')
    expect(params.status.schema.enum).toEqual(['open', 'won', 'lost'])
  })
  it('a filtered list with sort pages through a cursor with no row lost or repeated', async () => {
    await seed()
    const seen: string[] = []
    let path = '/api/v1/deals?amount_minor=not.is.null&sort=name&order=desc&limit=1'
    for (let i = 0; i < 6; i++) {
      const r = await call(FULL, 'GET', path)
      expect(r.status).toBe(200)
      seen.push(...r.body.data.map((d: any) => d.name))
      if (!r.body.next_cursor) break
      path = `/api/v1/deals?amount_minor=not.is.null&sort=name&order=desc&limit=1&after=${encodeURIComponent(r.body.next_cursor)}`
    }
    expect(seen).toEqual(['Gamma', 'Beta_100%', 'Acme pilot'])
  })
  it('paging without sort with a filter walks every match once', async () => {
    await seed()
    const seen: string[] = []
    let path = '/api/v1/deals?currency=ilike.*&limit=1'
    for (let i = 0; i < 6; i++) {
      const r = await call(FULL, 'GET', path)
      seen.push(...r.body.data.map((d: any) => d.name))
      if (!r.body.next_cursor) break
      path = `/api/v1/deals?currency=ilike.*&limit=1&after=${r.body.next_cursor}`
    }
    expect(seen.sort()).toEqual(['Acme pilot', 'Beta_100%', 'Gamma'])
  })
})
