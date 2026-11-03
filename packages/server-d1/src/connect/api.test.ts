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
    expect((calls[0]!.init.method ?? 'GET')).toBe('GET')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer token-1')
    expect(calls[0]!.init.credentials).toBe('omit')
  })

  it('agents(): pages with after= and limit=200 until next_cursor is null, a token per page', async () => {
    const pages = [json({ data: [{ id: 'a' }], next_cursor: 'c1' }), json({ data: [{ id: 'b' }], next_cursor: null })]
    const { api, calls } = rig(() => pages.shift()!)
    const r = await api.agents()
    expect(r.body).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/meta/v1/agents?limit=200`, `${ORIGIN}/meta/v1/agents?limit=200&after=c1`])
    expect(calls.map((c) => new Headers(c.init.headers).get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-2'])
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
    const api = createApi({ origin: ORIGIN, getToken: async () => null, fetch: (async (...a: unknown[]) => void calls.push(a)) as unknown as typeof fetch })
    expect((await api.me()).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('an unparseable body on any status is a null body, not a throw', async () => {
    const { api } = rig(() => new Response('<html>', { status: 502 }))
    expect(await api.me()).toEqual({ status: 502, body: null })
  })
})
