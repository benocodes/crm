import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { captureMessage } from '../test/capture-kit.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// [[CORE133]] over REST on the D1 app: sort and order (D8), the opaque cursor and its refusals (D9), the scope gate (D5),
// unsorted lists unchanged, and the OpenAPI document (per-list cursor typing, the stability caveat).
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const OWNER = 'owner@vibase.test'
const BASE = ['contacts:read', 'contacts:write']
const WITH = [...BASE, 'interactions:read']
const FULL = WITH
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVibaseRegistry())
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], method: string, path: string, body?: unknown) => {
  const res = await s.call(t, 'agent', scopes, method, path, body)
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}
const must = async (scopes: string[], method: string, path: string, body?: unknown) => {
  const r = await call(scopes, method, path, body)
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300)
  return r.body
}
const cursorOf = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const T_A = '2026-10-10T00:00:00.000Z'
const T_B = '2026-10-15T12:00:00.000Z'
const messageTo = (to: string, at: string) =>
  captureMessage(t.organizationId, {
    occurred_at: at,
    sent_by_connection: true,
    author: { user_id: OWNER, user_name: OWNER, full_name: 'Owner', is_bot: false },
    participants: [
      { kind: 'email', value: OWNER, role: 'from' },
      { kind: 'email', value: to, role: 'to' },
    ],
  })
/** A (contacted at T_A), B (T_B), C and D never. Returns ids by name. */
async function seed(): Promise<Record<'A' | 'B' | 'C' | 'D', string>> {
  await must(FULL, 'POST', '/api/v1/identities', { kind: 'email', value: OWNER, own: true })
  const ids: Record<string, string> = {}
  for (const n of ['A', 'B', 'C', 'D']) {
    const c = await must(FULL, 'POST', '/api/v1/contacts', { name: n })
    await must(FULL, 'POST', '/api/v1/identities', { kind: 'email', value: `${n.toLowerCase()}@x.test`, contact_id: c.id })
    ids[n] = c.id
  }
  await s.capture(t, { connection_id: C1, messages: [messageTo('a@x.test', T_A), messageTo('b@x.test', T_B)] })
  return ids as Record<'A' | 'B' | 'C' | 'D', string>
}

describe('sort and order (D8)', () => {
  it('sort alone is asc, nulls first; desc puts them last; the keys stay in the record', async () => {
    const ids = await seed()
    const asc = await must(WITH, 'GET', '/api/v1/contacts?sort=last_contacted_at')
    expect(asc.data.map((c: any) => c.last_contacted_at)).toEqual([null, null, T_A, T_B])
    expect(asc.data.map((c: any) => c.id).slice(0, 2)).toEqual([ids.C, ids.D].sort())
    const desc = await must(WITH, 'GET', '/api/v1/contacts?sort=last_contacted_at&order=desc')
    expect(desc.data.map((c: any) => c.last_contacted_at)).toEqual([T_B, T_A, null, null])
    expect(desc.data.map((c: any) => c.id).slice(2)).toEqual([ids.C, ids.D].sort().reverse())
    const inter = await must(WITH, 'GET', '/api/v1/contacts?sort=last_interacted_at&order=desc&limit=1')
    expect(inter.data.map((c: any) => c.id)).toEqual([ids.B])
  })

  it('pages with the opaque cursor to the end, with filters, and the pages concatenate to the whole set', async () => {
    await seed()
    const seen: string[] = []
    let path = '/api/v1/contacts?sort=last_contacted_at&order=desc&limit=1&not_contacted_since=2026-12-01T00:00:00Z'
    for (let i = 0; i < 10; i++) {
      const p = await must(WITH, 'GET', path)
      seen.push(...p.data.map((c: any) => c.name))
      if (p.next_cursor === null) break
      expect(p.next_cursor).not.toMatch(UUID)
      path = `/api/v1/contacts?sort=last_contacted_at&order=desc&limit=1&not_contacted_since=2026-12-01T00:00:00Z&after=${encodeURIComponent(p.next_cursor)}`
    }
    expect(seen).toEqual(['B', 'A', 'D', 'C'])
  })

  it('order without sort is 400, an unknown sort or order value is 400, and none of them runs a query that answers', async () => {
    await seed()
    for (const q of ['order=desc', 'order=asc', 'sort=no_such_field', 'sort=', 'sort=last_contacted_at&order=sideways', 'sort=last_contacted_at&order=']) {
      const r = await call(WITH, 'GET', `/api/v1/contacts?${q}`)
      expect(r.status, q).toBe(400)
      expect(r.body.error.code, q).toBe('validation_error')
    }
  })
})

describe('the cursor codec (D9)', () => {
  const sorted = (cursor: string, extra = 'sort=last_contacted_at&order=asc') => `/api/v1/contacts?${extra}&after=${encodeURIComponent(cursor)}`
  const id = '0190b2c4-0000-7000-8000-000000000001'

  it('a cursor from a page round-trips: the next page starts exactly after it', async () => {
    await seed()
    const first = await must(WITH, 'GET', '/api/v1/contacts?sort=last_contacted_at&limit=2')
    const second = await must(WITH, 'GET', sorted(first.next_cursor))
    expect([...first.data, ...second.data].map((c: any) => c.last_contacted_at)).toEqual([null, null, T_A, T_B])
  })

  it('a well-formed cursor that someone edited is a legitimate position', async () => {
    await seed()
    const r = await call(WITH, 'GET', sorted(cursorOf(['last_contacted_at', 'asc', T_A, id])))
    expect(r.status).toBe(200)
    expect(r.body.data.map((c: any) => c.last_contacted_at)).toEqual([T_A, T_B])
  })

  const malformed: Array<[string, string]> = [
    ['not base64url', '!!!not base64url!!!'],
    ['base64 padding', cursorOf(['last_contacted_at', 'asc', null, id]) + '=='],
    ['not JSON', cursorOf('this is not json')],
    ['JSON but not an array', cursorOf({ sort: 'last_contacted_at' })],
    ['three elements', cursorOf(['last_contacted_at', 'asc', null])],
    ['five elements', cursorOf(['last_contacted_at', 'asc', null, id, 'x'])],
    ['sort not a string', cursorOf([1, 'asc', null, id])],
    ['order not asc or desc', cursorOf(['last_contacted_at', 'up', null, id])],
    ['id not a UUID', cursorOf(['last_contacted_at', 'asc', null, 'row-12'])],
    ['id not a string', cursorOf(['last_contacted_at', 'asc', null, 12])],
    ['value a number for a timestamp', cursorOf(['last_contacted_at', 'asc', 1760000000, id])],
    ['value not ISO text', cursorOf(['last_contacted_at', 'asc', 'yesterday', id])],
    ['value a date only', cursorOf(['last_contacted_at', 'asc', '2026-10-10', id])],
    ['value an object', cursorOf(['last_contacted_at', 'asc', { at: T_A }, id])],
    ['empty', ''],
  ]
  for (const [name, cursor] of malformed) {
    it(`malformed: ${name} is 400 validation_error`, async () => {
      const r = await call(WITH, 'GET', sorted(cursor))
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('validation_error')
    })
  }

  it('a cursor carrying another sort or another order is 400', async () => {
    await seed()
    const first = await must(WITH, 'GET', '/api/v1/contacts?sort=last_contacted_at&order=asc&limit=1')
    for (const q of ['sort=last_interacted_at&order=asc', 'sort=last_contacted_at&order=desc', 'sort=last_contacted_at']) {
      // `sort=last_contacted_at` alone is asc, which matches; the third case must therefore succeed.
      const r = await call(WITH, 'GET', sorted(first.next_cursor, q))
      expect(r.status, q).toBe(q === 'sort=last_contacted_at' ? 200 : 400)
      if (r.status === 400) expect(r.body.error.code).toBe('validation_error')
    }
    const desc = await must(WITH, 'GET', '/api/v1/contacts?sort=last_contacted_at&order=desc&limit=1')
    expect((await call(WITH, 'GET', sorted(desc.next_cursor, 'sort=last_contacted_at'))).status).toBe(400)
  })

  it('a plain UUID with sort is 400, and a sorted cursor without sort is 400', async () => {
    await seed()
    expect((await call(WITH, 'GET', sorted(id))).status).toBe(400)
    const first = await must(WITH, 'GET', '/api/v1/contacts?sort=last_contacted_at&limit=1')
    const r = await call(WITH, 'GET', `/api/v1/contacts?after=${encodeURIComponent(first.next_cursor)}`)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('validation_error')
  })
})

describe('the scope gate (D5), over REST', () => {
  for (const sort of ['last_contacted_at', 'last_interacted_at']) {
    it(`sorting by ${sort} without interactions:read is 403 insufficient_scope naming it; with it, 200`, async () => {
      await seed()
      const no = await call(BASE, 'GET', `/api/v1/contacts?sort=${sort}`)
      expect(no.status).toBe(403)
      expect(no.body.error.code).toBe('insufficient_scope')
      expect(no.body.error.message).toContain('interactions:read')
      expect(JSON.stringify(no.body)).not.toMatch(/next_cursor/)
      expect((await call(WITH, 'GET', `/api/v1/contacts?sort=${sort}`)).status).toBe(200)
    })
  }
  it('without the scope the default list still works and carries no derived value in its cursor', async () => {
    await seed()
    const r = await must(BASE, 'GET', '/api/v1/contacts?limit=1')
    expect(r.next_cursor).toMatch(UUID)
    expect(JSON.stringify(r)).not.toMatch(/last_(contacted|interacted)_at/)
  })
})

describe('unsorted lists are unchanged', () => {
  it('contacts without sort: last-id cursor, a non-UUID after is 400, and the walk is id order', async () => {
    const ids = await seed()
    const p = await must(WITH, 'GET', '/api/v1/contacts?limit=2')
    expect(p.next_cursor).toBe(p.data[1].id)
    expect(p.next_cursor).toMatch(UUID)
    const bad = await call(WITH, 'GET', '/api/v1/contacts?after=not-a-uuid')
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('validation_error')
    const rest = await must(WITH, 'GET', `/api/v1/contacts?after=${p.next_cursor}`)
    expect([...p.data, ...rest.data].map((c: any) => c.id)).toEqual(Object.values(ids).sort())
  })
  // CORE188: no shipped list takes plain filters without sorts now; the negative is a definition with no sorts (define.test.ts).
})

describe('the OpenAPI document (D9)', () => {
  const doc = async () => (await (await s.app.request('/api/v1/openapi.json')).json()) as any
  const params = (d: any, path: string) => Object.fromEntries(d.paths[path].get.parameters.map((p: any) => [p.name, p]))
  const typeOf = (p: any) => p.schema ?? p
  const nextCursor = (d: any, path: string) => {
    const schema = d.paths[path].get.responses['200'].content['application/json'].schema
    return schema.properties.next_cursor
  }

  it('contacts: after and next_cursor are plain strings described as opaque, sort and order are enums', async () => {
    const d = await doc()
    const p = params(d, '/api/v1/contacts')
    expect(typeOf(p.after).type).toBe('string')
    expect(typeOf(p.after).format).toBeUndefined()
    expect(String(p.after.description ?? typeOf(p.after).description)).toMatch(/opaque/i)
    const next = nextCursor(d, '/api/v1/contacts')
    expect(JSON.stringify(next)).not.toContain('uuid')
    expect(JSON.stringify(next)).toContain('string')
    expect(String(next.description ?? '')).toMatch(/opaque/i)
    expect(JSON.stringify(typeOf(p.sort))).toContain('last_contacted_at')
    expect(JSON.stringify(typeOf(p.sort))).toContain('last_interacted_at')
    expect(JSON.stringify(typeOf(p.order))).toContain('desc')
    expect(p.sort.required).not.toBe(true)
    expect(p.order.required).not.toBe(true)
  })

  it('the hand-written lists left out by design (CORE175 D15, CORE188 D1) keep uuid for after and next_cursor and carry no sort parameter', async () => {
    const d = await doc()
    for (const path of ['/api/v1/associations']) {
      const p = params(d, path)
      expect(JSON.stringify(typeOf(p.after)), `${path} after`).toContain('uuid')
      expect(JSON.stringify(nextCursor(d, path)), `${path} next_cursor`).toContain('uuid')
      expect(p.sort, path).toBeUndefined()
      expect(p.order, path).toBeUndefined()
    }
  })

  it('the cursor-stability caveat reaches the document: values can rise between pages, so a contact may repeat in asc or be missed in desc; a complete walk uses the default order', async () => {
    const d = await doc()
    const p = params(d, '/api/v1/contacts')
    const text = String(p.sort.description ?? typeOf(p.sort).description ?? '')
    expect(text).toMatch(/rise between pages/)
    expect(text).toMatch(/repeat in asc/)
    expect(text).toMatch(/missed in desc/)
    expect(text).toMatch(/complete walk uses the default order/)
    expect(text).toMatch(/null/)
  })
})
