import { describe, expect, it, vi } from 'vitest'
import { createClient, isVibaseError } from './index.js'
import { sessionToken } from './session.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX608 D7 (P2): the session helper.
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name)
const text = (body: string, status = 200) => new Response(body, { status })

describe('DX608 D7 sessionToken', () => {
  it('without cookie: credentials include, no cookie header, GET <origin>/auth/token', async () => {
    const fetch = fakeFetch(() => jsonResponse({ token: 'T' }))
    expect(await sessionToken({ url: `${BASE}/some/path`, fetch })()).toBe('T')
    const call = fetch.calls[0]
    expect(call.url).toBe(`${BASE}/auth/token`)
    expect(call.init.credentials).toBe('include')
    expect(headerOf(call.init, 'cookie')).toBeNull()
    expect(call.init.method ?? 'GET').toBe('GET')
  })

  it('a string cookie: the cookie header and credentials omit', async () => {
    const fetch = fakeFetch(() => jsonResponse({ token: 'T' }))
    await sessionToken({ url: BASE, fetch, cookie: 'sid=1' })()
    expect(headerOf(fetch.calls[0].init, 'cookie')).toBe('sid=1')
    expect(fetch.calls[0].init.credentials).toBe('omit')
  })

  it('a function cookie is called once per call', async () => {
    const fetch = fakeFetch(() => jsonResponse({ token: 'T' }))
    const cookie = vi.fn(() => 'sid=2')
    const get = sessionToken({ url: BASE, fetch, cookie })
    await get()
    await get()
    expect(cookie).toHaveBeenCalledTimes(2)
    expect(headerOf(fetch.calls[1].init, 'cookie')).toBe('sid=2')
    expect(fetch.calls[1].init.credentials).toBe('omit')
  })

  it('401 is null; a 2xx without a non-empty string token is null', async () => {
    for (const response of [
      () => text('', 401),
      () => jsonResponse({}),
      () => jsonResponse({ token: '' }),
      () => jsonResponse({ token: 5 }),
      () => jsonResponse(null),
      () => jsonResponse('str'),
    ])
      expect(await sessionToken({ url: BASE, fetch: fakeFetch(response) })()).toBeNull()
  })

  it('an unparseable 2xx is invalid_response', async () => {
    const error = await sessionToken({ url: BASE, fetch: fakeFetch(() => text('<html>')) })().catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect([error.status, error.code]).toEqual([200, 'invalid_response'])
  })

  it('another status maps by D8: the envelope, else http_<status>', async () => {
    const a = await sessionToken({
      url: BASE,
      fetch: fakeFetch(() => jsonResponse({ error: { code: 'rate_limited', message: 'slow' } }, 429)),
    })().catch((e) => e)
    expect([a.status, a.code, a.message]).toEqual([429, 'rate_limited', 'slow'])
    const b = await sessionToken({ url: BASE, fetch: fakeFetch(() => text('boom', 500)) })().catch((e) => e)
    expect([b.status, b.code]).toEqual([500, 'http_500'])
  })

  it('a fetch rejection is network_error', async () => {
    const error = await sessionToken({
      url: BASE,
      fetch: (async () => {
        throw new TypeError('down')
      }) as typeof fetch,
    })().catch((e) => e)
    expect([error.status, error.code]).toEqual([0, 'network_error'])
  })

  it('never caches: two calls, two requests', async () => {
    const fetch = fakeFetch(() => jsonResponse({ token: 'T' }))
    const get = sessionToken({ url: BASE, fetch })
    await get()
    await get()
    expect(fetch.calls).toHaveLength(2)
  })

  it('as createClient auth, a null token is 401 no_credential with no API request sent', async () => {
    const authFetch = fakeFetch(() => text('', 401))
    const apiFetch = fakeFetch(() => jsonResponse({}))
    const vibase = createClient({ url: BASE, auth: sessionToken({ url: BASE, fetch: authFetch }), fetch: apiFetch })
    const error = await vibase.contacts.get({ id: 'x' }).catch((e) => e)
    expect([error.status, error.code]).toEqual([401, 'no_credential'])
    expect(authFetch.calls).toHaveLength(1)
    expect(apiFetch.calls).toHaveLength(0)
  })
})
