import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { recordMessagesOperation } from '../messaging/capture.js'
import { captureMessage, ensureConnection } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { compileOperation } from '@vibase/storage'
import { listOperation } from '../storage/crud.js'
import { messages } from './messages.js'
import { interactions } from './interactions.js'
import type { PreparedResource } from '../storage/definition.js'

const C = '0190b2c4-0000-7000-8000-0000000000c1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => { e = await openD1Engine() })
afterAll(async () => { await e.close() })
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry: createVibaseRegistry(), storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

describe('interactions and mail cursor integration (CORE174)', () => {
  it('interactions occurred_at desc walks contact join and thread filters', async () => {
    await seed()
    const rows = await e.rows('interactions')
    const contact = (await e.rows('identities')).find(r => r.value === 'jane@acme.test')!.contact_id
    const thread = (await e.rows('messages'))[0]!.thread_id
    for (const [filter, expected] of [
      [`contact_id=${contact}`, reference(rows, 'occurred_at', 'desc')],
      [`thread_id=${thread}`, reference(rows.filter(r => r.thread_id === thread), 'occurred_at', 'desc')],
    ] as const) {
      expect(await walk('interactions', `sort=occurred_at&order=desc&${filter}`)).toEqual(expected)
    }
  })

  it('binds mail cursors to sort and order, rejects malformed values, and round-trips valid pages', async () => {
    const rows = await seed()
    const first = await page('messages', 'sort=occurred_at&order=desc&limit=1')
    const next = await page('messages', `sort=occurred_at&order=desc&after=${first.next_cursor}`)
    expect([...first.data, ...next.data].map(r => r.id)).toEqual(reference(rows, 'occurred_at', 'desc'))
    const envelope = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const queries = [
      `sort=occurred_at&after=${rows[0]!.id}`, `after=${first.next_cursor}`,
      `sort=created_at&order=desc&after=${first.next_cursor}`, `sort=occurred_at&order=asc&after=${first.next_cursor}`,
      'order=desc', 'sort=occurred_at&after=!!!',
      `sort=occurred_at&after=${envelope({ sort: 'occurred_at' })}`,
      `sort=occurred_at&after=${envelope(['occurred_at', 'asc', 'yesterday', rows[0]!.id])}`,
      `sort=occurred_at&after=${envelope(['occurred_at', 'asc', 1, rows[0]!.id])}`,
      `sort=id&after=${envelope(['id', 'asc', rows[1]!.id, rows[0]!.id])}`,
    ]
    for (const q of queries) {
      const r = await call('messages', q)
      expect(r.status, q).toBe(400)
      expect(r.body.error.code, q).toBe('validation_error')
    }
  })
})

describe('mail authority and legacy behavior (CORE174)', () => {
  for (const resource of ['messages', 'interactions']) {
    it(`${resource}: only its read scope sorts, no scope refuses, unsorted UUID walks and events stay unchanged`, async () => {
      await seed()
      const before = await e.events()
      expect((await call(resource, 'sort=occurred_at', [`${resource}:read`])).status).toBe(200)
      const no = await call(resource, 'sort=occurred_at', [])
      expect(no.status).toBe(403)
      expect(no.body.error.code).toBe('insufficient_scope')
      const first = await page(resource, 'limit=1')
      expect(first.next_cursor).toBe(first.data[0].id)
      expect(first.next_cursor).toMatch(UUID)
      const rest = await page(resource, `after=${first.next_cursor}`)
      expect([...first.data, ...rest.data].map(r => r.id)).toEqual((await e.rows(resource)).map(r => r.id).sort())
      expect((await call(resource, 'after=not-a-uuid')).body.error.code).toBe('validation_error')
      expect(await e.events()).toEqual(before)
    })
  }
})

describe('mail OpenAPI and advertised MCP contracts (CORE174)', () => {
  const guidance = (text: string) => {
    for (const pattern of [/sort=created_at&order=desc/, /sort=occurred_at&order=desc/, /not a snapshot/, /complete walk uses the default order/, /incremental/, /newly arrived/, /backfilled/, /created_at.*temporary sort/i, /id.*indexed/i]) expect(text).toMatch(pattern)
  }
  for (const resource of ['messages', 'interactions']) {
    it(`${resource}: exact sort enums and opaque cursors with shared guidance on OpenAPI and MCP`, async () => {
      const doc = await (await app.request('/api/v1/openapi.json')).json() as any
      const get = doc.paths[`/api/v1/${resource}`].get
      const params = Object.fromEntries(get.parameters.map((p: any) => [p.name, p])) as any
      expect(params.sort, 'mail sort is advertised').toBeDefined()
      expect(params.sort.schema.enum).toEqual(['id', 'created_at', 'occurred_at'])
      expect(params.order.schema.enum).toEqual(['asc', 'desc'])
      expect(params.after.schema.type).toBe('string')
      expect(params.after.schema.format).toBeUndefined()
      expect(JSON.stringify(get.responses['200'].content['application/json'].schema.properties.next_cursor)).not.toContain('uuid')
      expect(get.responses['200'].content['application/json'].schema.properties.next_cursor.type).toEqual(['string', 'null'])
      guidance(params.sort.description ?? params.sort.schema.description)
      const token = mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes: [`${resource}:read`], kind: 'agent' })
      const rpc = async (method: string, params: unknown) => (await (await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any
      const list = await rpc('tools/list', {})
      const tool = list.result.tools.find((t: any) => t.name === `${resource}_list`)
      expect(tool.inputSchema.properties.sort, 'MCP advertises mail sort').toBeDefined()
      expect(tool.inputSchema.properties.sort.enum).toEqual(['id', 'created_at', 'occurred_at'])
      expect(tool.inputSchema.properties.order.enum).toEqual(['asc', 'desc'])
      expect(tool.inputSchema.properties.after.type).toBe('string')
      expect(tool.inputSchema.properties.after.format).toBeUndefined()
      expect(JSON.stringify(tool.outputSchema.properties.next_cursor)).not.toContain('uuid')
      expect(tool.outputSchema.properties.next_cursor.type).toEqual(['string', 'null'])
      guidance(tool.inputSchema.properties.sort.description)
      await seed()
      const response = await rpc('tools/call', { name: `${resource}_list`, arguments: { sort: 'occurred_at', order: 'desc', limit: 1 } })
      expect(response.result.isError).not.toBe(true)
      const result = response.result.structuredContent
      expect(result.data.map((r: any) => r.id)).toEqual(reference(await e.rows(resource), 'occurred_at', 'desc').slice(0, 1))
      expect(result.next_cursor).not.toMatch(UUID)
    })
  }
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

describe('adopted mail SQL plans (CORE174)', () => {
  it('occurred_at keeps the three proven index paths with production projections', async () => {
    for (const [def, filters, index] of [
      [messages, {}, 'idx_messages_occurred'],
      [messages, { thread_id: C }, 'idx_messages_thread_occurred'],
      [interactions, {}, 'idx_interactions_occurred'],
    ] as const) for (const order of ['asc', 'desc'] as const) {
      const read = compileOperation(listOperation(def as PreparedResource, e.env(), { sort: 'occurred_at', order, filters }), 'd1').reads[0]!
      const plan = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results!.map((r: any) => r.detail).join('\n')
      console.info(`${def.name} ${order} ${index}\nSQL ${read.sql}\nPLAN ${plan}`)
      expect(plan).toContain(index)
      expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    }
  })
  it('mail created_at retains its stated temporary-sort cost', async () => {
    for (const def of [messages, interactions]) {
      const read = compileOperation(listOperation(def as PreparedResource, e.env(), { sort: 'created_at', order: 'desc' }), 'd1').reads[0]!
      const plan = (await e.d1!.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.parameters).all()).results!.map((r: any) => r.detail).join('\n')
      console.info(`${def.name} created_at\nSQL ${read.sql}\nPLAN ${plan}`)
      expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY')
    }
  })
})
