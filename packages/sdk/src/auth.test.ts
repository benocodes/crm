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
    type Shape = { namespace: 'a'; method: string; args: {}; result: unknown; proposable: false; paginated: false }
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
