import { describe, expect, it } from 'vitest'
import { createClient } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX603 D5: the call. Flat arguments placed by the generated table.
const make = (handler: Parameters<typeof fakeFetch>[0] = () => jsonResponse({ ok: true })) => {
  const fetch = fakeFetch(handler)
  return { fetch, vibase: createClient({ url: BASE, auth: 'tok', fetch }) }
}

describe('DX603 D5 the call', () => {
  it('substitutes a path field URI-encoded (a slash and a space)', async () => {
    const { vibase, fetch } = make()
    await vibase.contacts.get({ id: 'a/b c' })
    expect(fetch.calls[0].url).toBe(`${BASE}/api/v1/contacts/a%2Fb%20c`)
    expect(fetch.calls[0].init.method).toBe('GET')
  })

  it('sends a query array as the repeated parameter and drops undefined', async () => {
    const { vibase, fetch } = make()
    await vibase.tasks.list({ status: ['a', 'b'], limit: 5, tag: undefined })
    const url = new URL(fetch.calls[0].url)
    expect(url.searchParams.getAll('status')).toEqual(['a', 'b'])
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.has('tag')).toBe(false)
    expect(url.pathname).toBe('/api/v1/tasks')
  })

  it('sends no body for an operation without a request body', async () => {
    const { vibase, fetch } = make()
    await vibase.contacts.get({ id: 'x' })
    expect(fetch.calls[0].init.body).toBeUndefined()
    expect(new Headers(fetch.calls[0].init.headers).has('content-type')).toBe(false)
  })

  it('sends a JSON body holding only the non-path, non-query fields', async () => {
    const { vibase, fetch } = make()
    await vibase.contacts.update({ id: 'c1', name: 'Ada' })
    expect(fetch.calls[0].url).toBe(`${BASE}/api/v1/contacts/c1`)
    expect(fetch.calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({ name: 'Ada' })
    expect(new Headers(fetch.calls[0].init.headers).get('content-type')).toBe('application/json')
  })

  it('sends a query field of a body operation in the query, not the body', async () => {
    const { vibase, fetch } = make()
    await vibase.contacts.create({ name: 'Ada' })
    expect(new URL(fetch.calls[0].url).search).toBe('')
    expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({ name: 'Ada' })
  })

  it('passes an undeclared field of a body operation through to the body', async () => {
    const { vibase, fetch } = make()
    await vibase.contacts.create({ name: 'Ada', plan__c: 'pro' } as never)
    expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({ name: 'Ada', plan__c: 'pro' })
  })

  it('passes the signal to fetch', async () => {
    const { vibase, fetch } = make()
    const controller = new AbortController()
    await vibase.contacts.get({ id: 'x' }, { signal: controller.signal })
    expect(fetch.calls[0].init.signal).toBe(controller.signal)
  })

  it('resolves undefined for a 204', async () => {
    const { vibase } = make(() => new Response(null, { status: 204 }))
    await expect(vibase.tasks.delete({ id: 'x' })).resolves.toBeUndefined()
  })

  it('resolves the checked Response for a binary success (files.content)', async () => {
    const response = new Response('PDF', { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    const { vibase } = make(() => response)
    const result = await vibase.files.content({ id: 'f1' })
    expect(result).toBe(response)
    expect(await result.text()).toBe('PDF')
  })

  it('resolves the parsed JSON body and honours a trailing slash on url', async () => {
    const fetch = fakeFetch(() => jsonResponse({ id: 'c1', name: 'Ada' }))
    const vibase = createClient({ url: `${BASE}/`, auth: 't', fetch })
    await expect(vibase.contacts.get({ id: 'c1' })).resolves.toEqual({ id: 'c1', name: 'Ada' })
    expect(fetch.calls[0].url).toBe(`${BASE}/api/v1/contacts/c1`)
  })
})
