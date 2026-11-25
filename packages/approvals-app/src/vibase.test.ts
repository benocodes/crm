// [[DX609]] groups 1 and 2: the four calls on the wire, and the list's pagination and cap.
import { describe, expect, it } from 'vitest'
import { API, fakeFetch, type Seen } from './test-kit.js'
import { createApi } from './vibase.js'

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes)
  let n = 0
  const tokens: string[] = []
  const api = createApi(
    API,
    async () => {
      const t = `tok-${++n}`
      tokens.push(t)
      return t
    },
    f.fetch,
  )
  return { api, seen: f.seen, tokens }
}
const REQ = { id: 'ar 1', status: 'pending' }
const common = (s: Seen, token: string) => {
  expect(s.headers.authorization).toBe(`Bearer ${token}`)
  expect(s.credentials).toBe('omit')
}

describe('the four calls on the wire (P3)', () => {
  it('list sends status, limit=100 and no after on the first page', async () => {
    const { api, seen } = setup({ 'GET /api/v1/action-requests': { data: [REQ], next_cursor: null } })
    expect(await api.list('pending')).toEqual([REQ])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('GET')
    const u = new URL(seen[0]!.url)
    expect(u.origin + u.pathname).toBe(`${API}/api/v1/action-requests`)
    expect(u.searchParams.get('status')).toBe('pending')
    expect(u.searchParams.get('limit')).toBe('100')
    expect(u.searchParams.has('after')).toBe(false)
    expect(seen[0]!.body).toBeUndefined()
    common(seen[0]!, 'tok-1')
  })

  it('get sends GET on the encoded id with a bearer and no body', async () => {
    const { api, seen } = setup({ 'GET /api/v1/action-requests/ar%201': REQ })
    expect(await api.get('ar 1')).toEqual(REQ)
    expect(seen[0]!.method).toBe('GET')
    expect(new URL(seen[0]!.url).pathname).toBe('/api/v1/action-requests/ar%201')
    expect(seen[0]!.body).toBeUndefined()
    common(seen[0]!, 'tok-1')
  })

  for (const verb of ['approve', 'reject'] as const) {
    it(`${verb} with a note sends { decision_reason }`, async () => {
      const { api, seen } = setup({ [`POST /api/v1/action-requests/ar%201/${verb}`]: REQ })
      await api[verb]('ar 1', 'looks fine')
      expect(seen[0]!.method).toBe('POST')
      expect(new URL(seen[0]!.url).pathname).toBe(`/api/v1/action-requests/ar%201/${verb}`)
      expect(JSON.parse(seen[0]!.body!)).toEqual({ decision_reason: 'looks fine' })
      common(seen[0]!, 'tok-1')
    })
    it(`${verb} without a note sends {}`, async () => {
      const { api, seen } = setup({ [`POST /api/v1/action-requests/ar%201/${verb}`]: REQ })
      await api[verb]('ar 1')
      expect(JSON.parse(seen[0]!.body!)).toEqual({})
      common(seen[0]!, 'tok-1')
    })
  }

  it('asks the token function afresh for every request', async () => {
    const { api, seen, tokens } = setup({
      'GET /api/v1/action-requests/ar%201': REQ,
      'POST /api/v1/action-requests/ar%201/approve': REQ,
    })
    await api.get('ar 1')
    await api.approve('ar 1')
    expect(tokens).toEqual(['tok-1', 'tok-2'])
    common(seen[0]!, 'tok-1')
    common(seen[1]!, 'tok-2')
  })
})

const page = (from: number, n: number, next: string | null) => ({
  data: Array.from({ length: n }, (_, i) => ({ id: `r${from + i}` })),
  next_cursor: next,
})

describe('the list follows cursors and caps at 2,000 items (P1)', () => {
  it('follows next_cursor across pages, sends it as after, and stops on null', async () => {
    const { api, seen } = setup({
      'GET /api/v1/action-requests': (req: Seen) => {
        const after = new URL(req.url).searchParams.get('after')
        if (after === null) return Response.json(page(0, 100, 'c1'))
        if (after === 'c1') return Response.json(page(100, 100, 'c2'))
        return Response.json(page(200, 7, null))
      },
    })
    const items = await api.list('pending')
    expect(items).toHaveLength(207)
    expect(seen.map((s) => new URL(s.url).searchParams.get('after'))).toEqual([null, 'c1', 'c2'])
  })

  it('with 25 full pages available it returns 2,000 items and sends exactly 20 list requests', async () => {
    const { api, seen } = setup({
      'GET /api/v1/action-requests': (req: Seen) => {
        const after = new URL(req.url).searchParams.get('after')
        const i = after === null ? 0 : Number(after)
        return Response.json(page(i * 100, 100, String(i + 1)))
      },
    })
    const items = await api.list('pending')
    expect(items).toHaveLength(2000)
    expect(seen).toHaveLength(20)
  })
})
