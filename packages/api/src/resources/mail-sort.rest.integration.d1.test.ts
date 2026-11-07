import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { recordMessagesOperation } from '../messaging/capture.js'
import { captureMessage, ensureConnection } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

const C = '0190b2c4-0000-7000-8000-0000000000c1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => { e = await openD1Engine() })
afterAll(async () => { await e.close() })
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry: createVaultRegistry(), storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
async function call(resource: string, query = '', scopes = [`${resource}:read`]) {
  const token = mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })
  const res = await app.request(`/api/v1/${resource}?${query}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json() as any }
}
async function page(resource: string, query: string) {
  const r = await call(resource, query)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body
}
// Real capture programs, with capture clocks advancing while the last message backfills older mail.
async function seed(count = 5) {
  await ensureConnection(e.binding, e, C)
  for (let n = 0; n < count; n++) {
    await e.run(recordMessagesOperation(e.env({ now: new Date(`2026-11-01T00:00:0${n}.000Z`) }), {
      connection_id: C,
      messages: [captureMessage(e.organizationId, {
        external_id: `mail-${n}@sort.test`, provider_thread_id: n === 3 ? 'other' : 'main',
        occurred_at: n === 4 ? '2020-01-01T00:00:00.000Z' : n === 0 ? '2026-10-01T00:00:00.000Z' : '2026-10-02T00:00:00.000Z',
      })],
    }))
  }
  return e.rows('messages')
}
function reference(rows: any[], sort: string, order: string) {
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return [...rows].sort((a, b) => (cmp(a[sort], b[sort]) || cmp(a.id, b.id)) * (order === 'desc' ? -1 : 1)).map(r => r.id)
}
async function walk(resource: string, query: string) {
  const ids: string[] = []
  let after: string | null = null
  for (let guard = 0; guard < 20; guard++) {
    const p = await page(resource, `${query}&limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`)
    ids.push(...p.data.map((r: any) => r.id))
    if (p.next_cursor === null) return ids
    expect(p.next_cursor).not.toMatch(UUID)
    after = p.next_cursor
  }
  throw new Error('walk did not terminate')
}

describe('messages first: backfill REST matrix (CORE174)', () => {
  for (const sort of ['id', 'created_at', 'occurred_at']) for (const order of ['asc', 'desc']) {
    it(`${sort} ${order}: plain and thread walks cross ties without misses or repeats`, async () => {
      const rows = await seed()
      const thread = rows.find(r => r.external_id === 'mail-0@sort.test')!.thread_id
      expect(rows[4]!.id > rows[0]!.id).toBe(true)
      for (const filter of ['', `&thread_id=${thread}`]) {
        const selected = filter ? rows.filter(r => r.thread_id === thread) : rows
        const expected = reference(selected, sort, order)
        const q = `sort=${sort}&order=${order}${filter}`
        expect((await page('messages', q)).data.map((r: any) => r.id)).toEqual(expected)
        expect(await walk('messages', q)).toEqual(expected)
      }
    })
  }
  it('empty and single-row sorted pages terminate', async () => {
    expect(await page('messages', 'sort=occurred_at&order=desc&limit=1')).toEqual({ data: [], next_cursor: null })
    const rows = await seed(1)
    const p = await page('messages', 'sort=occurred_at&order=desc&limit=1')
    expect(p.data.map((r: any) => r.id)).toEqual([rows[0]!.id])
    expect(p.next_cursor).toBeNull()
  })
})
