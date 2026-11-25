import { describe, expect, it, vi } from 'vitest'
import { createClient, isVibaseError } from './index.js'
import { BASE, fakeFetch, jsonResponse } from './testing.js'

// DX608 D10 (P3): .all() follows next_cursor.
const pages = (cursors: (string | null)[]) => {
  let n = 0
  return (call: { url: string }) => {
    const i = n++
    return jsonResponse({
      data: [{ id: `r${i}` }],
      next_cursor: cursors[i] ?? null,
      _after: new URL(call.url).searchParams.get('after'),
    })
  }
}
const collect = async (iter: AsyncIterable<any>, max = 20) => {
  const out: any[] = []
  for await (const item of iter) {
    out.push(item)
    if (out.length > max) throw new Error('unbounded pages')
  }
  return out
}
const afters = (fetch: ReturnType<typeof fakeFetch>) => fetch.calls.map((c) => new URL(c.url).searchParams.get('after'))

describe('DX608 D10 .all()', () => {
  it('follows three pages with after from each next_cursor, keeping limit', async () => {
    const fetch = fakeFetch(pages(['c1', 'c2', null]))
    const vibase = createClient({ url: BASE, auth: 't', fetch })
    const items = await collect(vibase.tasks.list.all({ limit: 1 }))
    expect(items.map((i) => i.id)).toEqual(['r0', 'r1', 'r2'])
    expect(afters(fetch)).toEqual([null, 'c1', 'c2'])
    expect(fetch.calls.map((c) => new URL(c.url).searchParams.get('limit'))).toEqual(['1', '1', '1'])
  })

  it('ignores an after in args on the first request', async () => {
    const fetch = fakeFetch(pages([null]))
    const vibase = createClient({ url: BASE, auth: 't', fetch })
    await collect(vibase.tasks.list.all({ after: 'stale' }))
    expect(afters(fetch)).toEqual([null])
  })

  for (const end of [null, ''])
    it(`${JSON.stringify(end)} ends the loop`, async () => {
      const fetch = fakeFetch(pages([end]))
      const vibase = createClient({ url: BASE, auth: 't', fetch })
      expect(await collect(vibase.tasks.list.all())).toHaveLength(1)
      expect(fetch.calls).toHaveLength(1)
    })

  it('a repeated cursor is invalid_response', async () => {
    const fetch = fakeFetch(pages(['c1', 'c1', 'c1', 'c1', 'c1']))
    const vibase = createClient({ url: BASE, auth: 't', fetch })
    const error = await collect(vibase.tasks.list.all(), 10).catch((e) => e)
    expect(isVibaseError(error)).toBe(true)
    expect(error.code).toBe('invalid_response')
    expect(fetch.calls.length).toBeLessThanOrEqual(3)
  })

  it('breaking out after the first item sends no second request', async () => {
    const fetch = fakeFetch(pages(['c1', 'c2', null]))
    const vibase = createClient({ url: BASE, auth: 't', fetch })
    for await (const _ of vibase.tasks.list.all()) break
    expect(fetch.calls).toHaveLength(1)
  })

  it('calls the credential once per page and passes the signal to every page', async () => {
    const fetch = fakeFetch(pages(['c1', 'c2', null]))
    const auth = vi.fn(() => 'tok')
    const vibase = createClient({ url: BASE, auth, fetch })
    const controller = new AbortController()
    await collect(vibase.tasks.list.all({}, { signal: controller.signal }))
    expect(auth).toHaveBeenCalledTimes(3)
    expect(fetch.calls.map((c) => c.init.signal)).toEqual([controller.signal, controller.signal, controller.signal])
  })
})
