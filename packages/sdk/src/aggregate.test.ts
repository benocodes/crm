import { describe, expect, it } from 'vitest'
import { deals } from '../../api/src/resources/deals.js'
import { parseAggregateTerms, parseGroupBy } from '../../api/src/storage/aggregate.js'
import { createClient, isVibaseError } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX616 D5: an array is sent comma-joined, a string as it is, an empty array is refused before any request, and nothing else is checked locally.
// The sent query is parsed by the server's own aggregate parsing (the DX608 lesson), not by the client's reading of it.
const make = () => {
  const fetch = fakeFetch(() => jsonResponse({ count: 0 }))
  return { fetch, vibase: createClient({ url: BASE, auth: 'tok', fetch }) }
}
const query = (fetch: ReturnType<typeof fakeFetch>) => new URL(fetch.calls[0].url).searchParams

describe('DX616 D5 aggregate list parameters on the wire', () => {
  it('sends an array comma-joined and a string as given, and the server parses both the same way', async () => {
    const { vibase, fetch } = make()
    await vibase.deals.aggregate({ min: ['created_at', 'name'], max: 'updated_at', group_by: ['stage_id', 'currency'] })
    const q = query(fetch)
    expect([q.getAll('min'), q.getAll('max'), q.getAll('group_by')]).toEqual([
      ['created_at,name'],
      ['updated_at'],
      ['stage_id,currency'],
    ])
    const terms = parseAggregateTerms(deals as never, { min: q.get('min'), max: q.get('max') })
    expect([terms.min, terms.max]).toEqual([['created_at', 'name'], ['updated_at']])
    expect(parseGroupBy(deals as never, q.get('group_by'))).toEqual(['stage_id', 'currency'])
  })

  it('sends one field as the string it is, with the filters beside it', async () => {
    const { vibase, fetch } = make()
    await vibase.deals.aggregate({ sum: 'amount_minor', group_by: 'stage_id', status: 'open' })
    const q = query(fetch)
    expect([q.get('sum'), q.get('group_by'), q.get('status')]).toEqual(['amount_minor', 'stage_id', 'open'])
  })

  it.each(['sum', 'avg', 'min', 'max', 'group_by'])('refuses an empty %s array before any request', async (name) => {
    const { vibase, fetch } = make()
    const error = await (vibase.deals.aggregate as any)({ [name]: [] }).catch((e: unknown) => e)
    expect(isVibaseError(error)).toBe(true)
    expect([error.status, error.code, error.message]).toEqual([
      400,
      'validation_error',
      `${name}: give at least one field; nothing was sent`,
    ])
    expect(fetch.calls).toEqual([])
  })

  it('checks no names locally: a misspelt field goes out and the server answers its own 400', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse({ error: { code: 'validation_error', message: 'sum takes: amount_minor' } }, 400),
    )
    const vibase = createClient({ url: BASE, auth: 'tok', fetch })
    const error = await (vibase.deals.aggregate as any)({ sum: ['nope', 'nope'] }).catch((e: unknown) => e)
    expect(fetch.calls.length).toBe(1)
    expect(new URL(fetch.calls[0].url).searchParams.get('sum')).toBe('nope,nope')
    expect([error.status, error.message]).toEqual([400, 'sum takes: amount_minor'])
  })

  it('an operation outside the aggregate table keeps sending an array as repeated values', async () => {
    const { vibase, fetch } = make()
    await (vibase.tasks.list as any)({ status: undefined, sort: ['a', 'b'] })
    expect(new URL(fetch.calls[0].url).searchParams.getAll('sort')).toEqual(['a', 'b'])
  })
})
