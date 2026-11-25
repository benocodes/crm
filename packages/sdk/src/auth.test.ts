import { describe, expect, it, vi } from 'vitest'
import { createClient, isVibaseError, type OperationTable } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX603 D6: bearer auth, credentials omit, redirect error, origin guard.
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

describe('DX603 D6 auth', () => {
  it('sends a string token as a bearer credential', async () => {
    const fetch = fakeFetch(() => jsonResponse({}))
    await createClient({ url: BASE, auth: 'secret', fetch }).contacts.get({ id: 'x' })
    expect(headerOf(fetch.calls[0].init, 'authorization')).toBe('Bearer secret')
  })

  it('calls a function credential once per request, with each token sent', async () => {
    const fetch = fakeFetch(() => jsonResponse({}))
    let n = 0
    const auth = vi.fn(async () => `t${++n}`)
    const vibase = createClient({ url: BASE, auth, fetch })
    await vibase.contacts.get({ id: 'x' })
    await vibase.contacts.get({ id: 'y' })
    expect(auth).toHaveBeenCalledTimes(2)
    expect(fetch.calls.map((c) => headerOf(c.init, 'authorization'))).toEqual(['Bearer t1', 'Bearer t2'])
  })

  it('throws 401 no_credential for null and never calls fetch', async () => {
    const fetch = fakeFetch(() => jsonResponse({}))
    const vibase = createClient({ url: BASE, auth: () => null, fetch })
    const error = await vibase.contacts.get({ id: 'x' }).catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect(error).toMatchObject({ status: 401, code: 'no_credential' })
    expect(fetch.calls).toHaveLength(0)
  })

  it('sends every request with credentials omit and redirect error', async () => {
    const fetch = fakeFetch(() => jsonResponse({}))
    const vibase = createClient({ url: BASE, auth: 't', fetch })
    await vibase.contacts.get({ id: 'x' })
    await vibase.contacts.create({ name: 'A' })
    for (const call of fetch.calls) expect(call.init).toMatchObject({ credentials: 'omit', redirect: 'error' })
  })

  it('refuses an absolute or // path before the credential is read, and sends nothing', async () => {
    const entry = (path: string) => ({
      namespace: 'x',
      method: 'y',
      http: 'GET' as const,
      path,
      fields: {},
      body: false,
      output: 'json' as const,
      paginated: false as const,
      proposable: false as const,
      filters: {},
    })
    type Ops = { 'a.one': Shape; 'a.two': Shape; 'a.three': Shape }
    type Shape = {
      namespace: 'a'
      method: string
      args: Record<never, never>
      result: unknown
      proposable: false
      paginated: false
    }
    const operations = {
      'a.one': { ...entry('https://evil.example/steal'), namespace: 'a', method: 'one' },
      'a.two': { ...entry('//evil.example/steal'), namespace: 'a', method: 'two' },
      'a.three': { ...entry('/\\evil.example/steal'), namespace: 'a', method: 'three' },
    } as unknown as OperationTable<Ops>
    const auth = vi.fn(() => 'secret')
    const fetch = fakeFetch(() => jsonResponse({}))
    const vibase = createClient({ url: BASE, auth, fetch, operations }) as unknown as Record<
      'a',
      Record<'one' | 'two' | 'three', () => Promise<unknown>>
    >
    for (const method of ['one', 'two', 'three'] as const) {
      const error = await vibase.a[method]().catch((e) => e)
      expect(error).toMatchObject({ code: 'origin_mismatch' })
    }
    expect(auth).not.toHaveBeenCalled()
    expect(fetch.calls).toHaveLength(0)
  })
})

describe('DX603 D6 redirects on a runtime without redirect: error (workerd)', () => {
  const workerdFetch = () =>
    fakeFetch(({ init }) => {
      if (init.redirect === 'error')
        throw new TypeError(
          'Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented)',
        )
      return jsonResponse({ ok: true })
    })

  it('retries once with redirect manual and remembers it for the client', async () => {
    const fetch = workerdFetch()
    const vibase = createClient({ url: BASE, auth: 't', fetch })
    await expect(vibase.contacts.get({ id: 'x' })).resolves.toEqual({ ok: true })
    await vibase.contacts.get({ id: 'y' })
    expect(fetch.calls.map((c) => c.init.redirect)).toEqual(['error', 'manual', 'manual'])
  })

  it('refuses a redirect response in manual mode as unexpected_redirect', async () => {
    const fetch = fakeFetch(({ init }) => {
      if (init.redirect === 'error') throw new TypeError('Invalid redirect value')
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    })
    const error = await createClient({ url: BASE, auth: 't', fetch })
      .contacts.get({ id: 'x' })
      .catch((e) => e)
    expect(error).toMatchObject({ status: 302, code: 'unexpected_redirect' })
  })

  it('does not retry a TypeError that is not about the redirect option', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    const error = await createClient({ url: BASE, auth: 't', fetch })
      .contacts.get({ id: 'x' })
      .catch((e) => e)
    expect(error).toMatchObject({ status: 0, code: 'network_error' })
    expect(fetch.calls).toHaveLength(1)
  })
})
