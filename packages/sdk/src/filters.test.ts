import { describe, expect, it } from 'vitest'
import { parseCondition } from '../../api/src/storage/column-filters.js'
import { createClient, isVibaseError } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX608 D9 (P1): the filter serialiser, one case per form, through an injected fetch.
const make = () => {
  const fetch = fakeFetch(() => jsonResponse({ data: [], next_cursor: null }))
  return { fetch, vibase: createClient({ url: BASE, auth: 'tok', fetch }) }
}
const sent = (fetch: ReturnType<typeof fakeFetch>, name: string) =>
  new URL(fetch.calls[0].url).searchParams.getAll(name)

describe('DX608 D9 filter serialisation', () => {
  it('a bare string, number and boolean are each eq', async () => {
    const a = make()
    await a.vibase.tasks.list({ title: 'hello' })
    expect(sent(a.fetch, 'title')).toEqual(['eq.hello'])
    const b = make()
    await b.vibase.deals.list({ amount_minor: 5 })
    expect(sent(b.fetch, 'amount_minor')).toEqual(['eq.5'])
    const c = make()
    await c.vibase.forms.list({ enabled: true })
    expect(sent(c.fetch, 'enabled')).toEqual(['eq.true'])
  })

  it('a value that reads as an operator is sent eq.<value>', async () => {
    const { vibase, fetch } = make()
    await vibase.tasks.list({ title: 'is.gd' })
    expect(sent(fetch, 'title')).toEqual(['eq.is.gd'])
  })

  it('{ gte, lt } on a timestamp is two repeated conditions', async () => {
    const { vibase, fetch } = make()
    await vibase.tasks.list({ created_at: { gte: '2026-01-01T00:00:00Z', lt: '2026-02-01T00:00:00Z' } })
    expect(sent(fetch, 'created_at')).toEqual(['gte.2026-01-01T00:00:00Z', 'lt.2026-02-01T00:00:00Z'])
  })

  it('a Date operand is its ISO string', async () => {
    const { vibase, fetch } = make()
    await vibase.tasks.list({ created_at: { gte: new Date('2026-03-04T05:06:07.000Z') } })
    expect(sent(fetch, 'created_at')).toEqual(['gte.2026-03-04T05:06:07.000Z'])
  })

  it('in quotes an item holding , ( ) and " and the server grammar reads it back', async () => {
    const { vibase, fetch } = make()
    const items = ['plain', 'a,b', 'c(d)', 'say "hi"', 'back\\slash']
    await vibase.tasks.list({ title: { in: items } })
    const [value] = sent(fetch, 'title')
    expect(value.startsWith('in.(')).toBe(true)
    const parsed = parseCondition('title', { kind: 'text', nullable: false }, value)
    expect(parsed).toEqual({ not: false, op: 'in', value: items })
  })

  it('is: null and is: true', async () => {
    const a = make()
    await a.vibase.tasks.list({ assignee_id: { is: null } })
    expect(sent(a.fetch, 'assignee_id')).toEqual(['is.null'])
    const b = make()
    await b.vibase.tasks.list({ completed_at: { is: null } })
    expect(sent(b.fetch, 'completed_at')).toEqual(['is.null'])
  })

  it('like and ilike keep their *', async () => {
    const { vibase, fetch } = make()
    await vibase.tasks.list({ title: { like: 'ab*', ilike: '*cd' } })
    expect(sent(fetch, 'title')).toEqual(['like.ab*', 'ilike.*cd'])
  })

  it('not with eq and with in', async () => {
    const a = make()
    await a.vibase.tasks.list({ status: { not: { eq: 'done' } } })
    expect(sent(a.fetch, 'status')).toEqual(['not.eq.done'])
    const b = make()
    await b.vibase.tasks.list({ status: { not: { in: ['a', 'b,c'] } } })
    expect(sent(b.fetch, 'status')).toEqual(['not.in.(a,"b,c")'])
  })

  it('outer and not keys are counted together against the cap, locally, before fetch', async () => {
    const ok = make()
    await ok.vibase.tasks.list({ title: { gt: 'a', lt: 'z', not: { eq: 'm', neq: 'n' } } })
    expect(sent(ok.fetch, 'title')).toHaveLength(4)
    const { vibase, fetch } = make()
    const error = await vibase.tasks
      .list({ title: { gt: 'a', gte: 'b', lt: 'z', lte: 'y', not: { eq: 'm' } } })
      .catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect([error.status, error.code]).toEqual([400, 'validation_error'])
    expect(fetch.calls).toHaveLength(0)
  })

  it('the cap is the parameter\'s own maxItems from the table, not a constant', async () => {
    const fetch = fakeFetch(() => jsonResponse({}))
    const vibase = createClient({
      url: BASE,
      auth: 't',
      fetch,
      operations: {
        'x.list': {
          namespace: 'x',
          method: 'list',
          http: 'GET',
          path: '/api/v1/x',
          fields: { n: 'query' },
          body: false,
          output: 'json',
          paginated: false,
          proposable: false,
          filters: { n: { kind: 'integer', operators: ['eq', 'gt', 'lt'], max: 2 } },
        },
      } as never,
    }) as any
    await vibase.x.list({ n: { gt: 1, lt: 5 } })
    expect(fetch.calls).toHaveLength(1)
    const error = await vibase.x.list({ n: { gt: 1, lt: 5, eq: 3 } }).catch((e: unknown) => e)
    expect([error.status, error.code]).toEqual([400, 'validation_error'])
    expect(fetch.calls).toHaveLength(1)
  })

  it('a non-filter parameter (limit, sort) is sent as given', async () => {
    const { vibase, fetch } = make()
    await vibase.tasks.list({ limit: 5, sort: 'created_at', order: 'desc' })
    expect(sent(fetch, 'limit')).toEqual(['5'])
    expect(sent(fetch, 'sort')).toEqual(['created_at'])
    expect(sent(fetch, 'order')).toEqual(['desc'])
  })
})
