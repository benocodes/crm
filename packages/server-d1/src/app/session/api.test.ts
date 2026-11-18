import { describe, expect, it } from 'vitest'
import { createApi } from './api.js'

// [[UI30]] D8: the three calls the page makes, nothing else, with a fresh token each and an `Authorization: Bearer` header.

const ORIGIN = 'https://api.acme.example'
type Call = { url: string; init: RequestInit }
const rig = (respond: () => Response) => {
  const calls: Call[] = []
  let n = 0
  const api = createApi({
    origin: ORIGIN,
    getToken: async () => `token-${++n}`,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return respond()
    }) as typeof fetch,
  })
  return { api, calls }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

describe('createApi', () => {
  it('me(): GET /meta/v1/me on the page origin with the bearer token', async () => {
    const { api, calls } = rig(() => json({ principal: { id: 'p', kind: 'user' } }))
    const r = await api.me()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ principal: { id: 'p' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${ORIGIN}/meta/v1/me`)
    expect(calls[0]!.init.method ?? 'GET').toBe('GET')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer token-1')
    expect(calls[0]!.init.credentials).toBe('omit')
  })

  it('agents(): pages with after= and limit=200 until next_cursor is null, a token per page', async () => {
    const pages = [json({ data: [{ id: 'a' }], next_cursor: 'c1' }), json({ data: [{ id: 'b' }], next_cursor: null })]
    const { api, calls } = rig(() => pages.shift()!)
    const r = await api.agents()
    expect(r.body).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/meta/v1/agents?limit=200`,
      `${ORIGIN}/meta/v1/agents?limit=200&after=c1`,
    ])
    expect(calls.map((c) => new Headers(c.init.headers).get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ])
  })

  it('agents(): a non-2xx page ends the walk with that status', async () => {
    const pages = [json({ data: [{ id: 'a' }], next_cursor: 'c1' }), json({ error: {} }, 401)]
    const { api } = rig(() => pages.shift()!)
    const r = await api.agents()
    expect(r.status).toBe(401)
    expect(r.body).toBeNull()
  })

  it('setDisabled(): PATCH /meta/v1/agents/{id} with {disabled}', async () => {
    const { api, calls } = rig(() => json({ id: 'x', disabled_at: 't' }))
    const r = await api.setDisabled('x/../y', true)
    expect(r.body).toMatchObject({ disabled_at: 't' })
    expect(calls[0]!.url).toBe(`${ORIGIN}/meta/v1/agents/${encodeURIComponent('x/../y')}`)
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ disabled: true })
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json')
  })

  it('no token: no request, status 401 (the page treats it as signed out)', async () => {
    const calls: unknown[] = []
    const api = createApi({
      origin: ORIGIN,
      getToken: async () => null,
      fetch: (async (...a: unknown[]) => void calls.push(a)) as unknown as typeof fetch,
    })
    expect((await api.me()).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('an unparseable body on any status is a null body, not a throw', async () => {
    const { api } = rig(() => new Response('<html>', { status: 502 }))
    expect(await api.me()).toEqual({ status: 502, body: null })
  })
})

// [[UI461]] P4 (group 3): hasEnabledAgent follows the cursor until it finds an agent with disabled_at null or the list ends.
describe('hasEnabledAgent', () => {
  const agent = (id: string, disabled: string | null) => ({ id, disabled_at: disabled })
  const walk = (...pages: Response[]) => {
    const q = [...pages]
    return rig(() => q.shift()!)
  }
  it('an empty list is false after one request', async () => {
    const { api, calls } = walk(json({ data: [], next_cursor: null }))
    expect(await api.hasEnabledAgent()).toEqual({ status: 200, body: false })
    expect(calls).toHaveLength(1)
  })
  it('only disabled agents on every page is false (a disabled agent is not connected)', async () => {
    const { api, calls } = walk(
      json({ data: [agent('a', '2026-01-01')], next_cursor: 'c1' }),
      json({ data: [agent('b', '2026-01-02')], next_cursor: null }),
    )
    expect((await api.hasEnabledAgent()).body).toBe(false)
    expect(calls).toHaveLength(2)
  })
  it('an enabled agent on the first page stops the walk after one request', async () => {
    const { api, calls } = walk(json({ data: [agent('a', null)], next_cursor: 'c1' }))
    expect((await api.hasEnabledAgent()).body).toBe(true)
    expect(calls).toHaveLength(1)
  })
  it('an enabled agent only on the second page is found, with after= and a token per page', async () => {
    const { api, calls } = walk(
      json({ data: [agent('a', '2026-01-01')], next_cursor: 'c1' }),
      json({ data: [agent('b', null)], next_cursor: null }),
    )
    expect((await api.hasEnabledAgent()).body).toBe(true)
    expect(calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/meta/v1/agents?limit=200`,
      `${ORIGIN}/meta/v1/agents?limit=200&after=c1`,
    ])
    expect(calls.map((c) => c.init.method ?? 'GET')).toEqual(['GET', 'GET'])
  })
  it('a non-2xx page ends the walk with that status and no answer', async () => {
    const { api } = walk(json({}, 403))
    expect(await api.hasEnabledAgent()).toEqual({ status: 403, body: null })
  })
  it('a cursor that never ends is bounded (100 requests), and the answer is false', async () => {
    const { api, calls } = rig(() => json({ data: [agent('a', '2026-01-01')], next_cursor: 'again' }))
    expect((await api.hasEnabledAgent()).body).toBe(false)
    expect(calls).toHaveLength(100)
  })
})

// [[UI467]] D2, D3, P5: the three calls the Connected accounts page makes.
describe('the Connected accounts calls', () => {
  it('connections(): pages /meta/v1/connections with limit=200 and after= until next_cursor is null', async () => {
    const pages = [json({ data: [{ id: 'a' }], next_cursor: 'c1' }), json({ data: [{ id: 'b' }], next_cursor: null })]
    const { api, calls } = rig(() => pages.shift()!)
    const r = await api.connections()
    expect(r.body).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/meta/v1/connections?limit=200`,
      `${ORIGIN}/meta/v1/connections?limit=200&after=c1`,
    ])
  })

  it('connections(): a failed page ends the walk with its status and error code', async () => {
    const pages = [json({ data: [{ id: 'a' }], next_cursor: 'c1' }), json({ error: { code: 'boom' } }, 500)]
    const { api } = rig(() => pages.shift()!)
    expect(await api.connections()).toEqual({ status: 500, body: null, code: 'boom' })
  })

  it('identityAddress(): GET /api/v1/identities/{id} and the body is the identity value', async () => {
    const { api, calls } = rig(() => json({ id: 'i1', kind: 'email', value: 'ann@x.test' }))
    const r = await api.identityAddress('i 1')
    expect(r).toEqual({ status: 200, body: 'ann@x.test' })
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/v1/identities/i%201`)
  })

  it('identityAddress(): a refusal is a null body with its status', async () => {
    const { api } = rig(() => json({ error: { code: 'insufficient_scope' } }, 403))
    expect(await api.identityAddress('i1')).toEqual({ status: 403, body: null, code: 'insufficient_scope' })
  })

  it('authorizeGmail(): POST /meta/v1/connections/authorize with exactly { provider: "google" }', async () => {
    const { api, calls } = rig(() => json({ authorize_url: 'https://accounts.google.test/o', expires_at: 't' }))
    const r = await api.authorizeGmail()
    expect(r.body).toMatchObject({ authorize_url: 'https://accounts.google.test/o' })
    expect(calls[0]!.url).toBe(`${ORIGIN}/meta/v1/connections/authorize`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ provider: 'google' })
  })

  it('authorizeGmail(): a 501 carries its error code', async () => {
    const { api } = rig(() => json({ error: { code: 'provider_not_configured' } }, 501))
    expect(await api.authorizeGmail()).toEqual({ status: 501, body: null, code: 'provider_not_configured' })
  })
})
