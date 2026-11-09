import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { fullPath, type Surface } from '../surfaces.js'
import { ensureConnection } from '../test/capture-kit.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { kindsOf } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CORE175]] D1, D2, D5, D8, D14: the remaining lists adopt the sort foundation. One matrix over list x accepted sort x order, on D1 through
// REST: the sort enums D1 names, opaque cursors, and a small-page walk equal to the reference order (nulls lowest, ties by id), on fixtures that
// force ties and nulls. Mail (messages, interactions) keeps its own CORE174 matrix (mail-sort.rest.integration.d1.test.ts).
const T1 = '2026-10-01T08:00:00.000Z'
const T2 = '2026-10-02T08:00:00.456Z'
const T3 = '2026-10-03T08:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const S = ['b', 'B', null, 'b', 'a', null] // text with a tie and nulls
const N = ['b', 'B', 'a', 'b', 'B', 'a'] // NOT NULL text with ties
const D = [T1, null, T1, T2, null, T2]
const CT = [T1, T2, T1, T2, T3, T1]
const UT = [T3, T1, T1, T2, T2, T3]
const ROWS = [0, 1, 2, 3, 4, 5]

/** The sorts D1 names for each list: convention first, then the natural fields. Contacts' derived sorts are proven by the CORE133 suites. */
const EXPECTED: Record<string, string[]> = {
  tasks: ['id', 'created_at', 'updated_at', 'due_at', 'title'],
  companies: ['id', 'created_at', 'updated_at', 'name'],
  contacts: ['id', 'created_at', 'updated_at', 'name', 'last_contacted_at', 'last_interacted_at'],
  identities: ['id', 'created_at', 'updated_at', 'value'],
  notes: ['id', 'created_at', 'updated_at', 'title'],
  tags: ['id', 'created_at', 'updated_at', 'name'],
  pipelines: ['id', 'created_at', 'updated_at', 'name'],
  pipeline_stages: ['id', 'created_at', 'updated_at', 'position', 'name'],
  deals: ['id', 'created_at', 'updated_at', 'name'],
  connections: ['id', 'created_at', 'updated_at', 'last_synced_at'],
  threads: ['id', 'created_at', 'subject'],
  messages: ['id', 'created_at', 'occurred_at'],
  interactions: ['id', 'created_at', 'occurred_at'],
  files: ['id', 'created_at', 'name'],
  contact_files: ['id', 'created_at', 'updated_at'],
  company_files: ['id', 'created_at', 'updated_at'],
  memberships: ['id', 'created_at', 'updated_at'],
  agents: ['id', 'created_at', 'updated_at', 'name'],
  api_keys: ['id', 'created_at', 'updated_at', 'last_used_at', 'expires_at'],
  action_requests: ['id', 'created_at', 'updated_at', 'expires_at', 'decided_at'],
}
const DERIVED = new Set(['last_contacted_at', 'last_interacted_at'])

let e: Engine
let app: ReturnType<typeof createApp>
const registry = createVaultRegistry()
const ALL = registry.declaredScopes()
beforeAll(async () => {
  e = await openD1Engine()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => { await e?.close() })

const token = (scopes: string[]) => mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })
async function call(path: string, scopes: string[] = ALL) {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token(scopes)}` } })
  return { status: res.status, body: (await res.json()) as any }
}
const pathOf = (list: string) => fullPath(registry.get(`${list}.list`) as { surface: Surface; path: string })
const stamped = (table: string, i: number, row: Record<string, unknown>) => {
  const kinds = kindsOf(table)
  return { ...row, ...('created_at' in kinds ? { created_at: CT[i] } : {}), ...('updated_at' in kinds ? { updated_at: UT[i] } : {}) }
}
async function insertAll(table: string, make: (i: number) => Record<string, unknown>) {
  for (const i of ROWS) await e.insert(table, stamped(table, i, { id: id(100 + i), ...make(i) }))
}

interface ListSpec { name: string; seed: () => Promise<void>; unique?: string[]; nullable: string[] }
const specs: ListSpec[] = [
  { name: 'threads', nullable: ['subject'], seed: () => insertAll('threads', (i) => ({ channel: 'email', subject: S[i] })) },
  { name: 'contacts', nullable: ['name'], seed: () => insertAll('contacts', (i) => ({ name: S[i] })) },
  { name: 'companies', nullable: [], seed: () => insertAll('companies', (i) => ({ name: N[i] })) },
  {
    name: 'deals', nullable: [],
    seed: async () => {
      await e.insert('pipelines', { id: id(1), name: 'P' })
      await e.insert('pipeline_stages', { id: id(2), pipeline_id: id(1), name: 'S', kind: 'open', position: 0 })
      await insertAll('deals', (i) => ({ name: N[i], pipeline_id: id(1), stage_id: id(2) }))
    },
  },
  { name: 'tasks', nullable: ['due_at'], seed: () => insertAll('tasks', (i) => ({ title: N[i], due_at: D[i] })) },
  { name: 'notes', nullable: ['title'], seed: () => insertAll('notes', (i) => ({ title: S[i], content: 'c' })) },
  { name: 'tags', unique: ['name'], nullable: [], seed: () => insertAll('tags', (i) => ({ name: ['b', 'a', 'C', 'd', 'E', 'f'][i] })) },
  { name: 'pipelines', unique: ['name'], nullable: [], seed: () => insertAll('pipelines', (i) => ({ name: ['b', 'a', 'C', 'd', 'E', 'f'][i] })) },
  {
    name: 'pipeline_stages', unique: ['name'], nullable: [],
    seed: async () => {
      await e.insert('pipelines', { id: id(1), name: 'P' })
      await insertAll('pipeline_stages', (i) => ({ pipeline_id: id(1), name: ['b', 'a', 'C', 'd', 'E', 'f'][i], kind: 'open', position: [0, 1, 1, 2, 2, 3][i] }))
    },
  },
  { name: 'identities', unique: ['value'], nullable: [], seed: () => insertAll('identities', (i) => ({ kind: 'email', value: `${['b', 'a', 'c', 'e', 'd', 'f'][i]}@sort.test`, contact_id: null, own: true })) },
  { name: 'files', nullable: [], seed: () => insertAll('files', (i) => ({ name: N[i], mime_type: 'text/plain', size_bytes: 1, sha256: 'a'.repeat(64), storage_key: `files/${i}` })) },
  {
    name: 'contact_files', nullable: [],
    seed: async () => {
      await e.insert('contacts', { id: id(1), name: 'c' })
      for (const i of ROWS) await e.insert('files', { id: id(200 + i), name: `f${i}`, mime_type: 'text/plain', size_bytes: 1, sha256: 'a'.repeat(64), storage_key: `cf/${i}` })
      await insertAll('contact_files', (i) => ({ contact_id: id(1), file_id: id(200 + i) }))
    },
  },
  {
    name: 'company_files', nullable: [],
    seed: async () => {
      await e.insert('companies', { id: id(1), name: 'c' })
      for (const i of ROWS) await e.insert('files', { id: id(200 + i), name: `f${i}`, mime_type: 'text/plain', size_bytes: 1, sha256: 'a'.repeat(64), storage_key: `cf/${i}` })
      await insertAll('company_files', (i) => ({ company_id: id(1), file_id: id(200 + i) }))
    },
  },
  {
    name: 'memberships', nullable: [],
    seed: async () => {
      for (const i of [0, 1, 2, 3]) {
        const m = await e.seedMember('member', { subject: `user_sort_${i}`, email: `sort${i}@sort.test` })
        await e.update('memberships', m.membershipId, { created_at: CT[i], updated_at: UT[i] })
      }
    },
  },
  {
    name: 'agents', nullable: [],
    seed: async () => {
      for (const i of ROWS) {
        await e.insert('principals', { id: id(100 + i), kind: 'agent' })
        await e.insert('agents', stamped('agents', i, { id: id(100 + i), name: N[i], scopes: [] }))
      }
    },
  },
  { name: 'api_keys', nullable: ['last_used_at', 'expires_at'], seed: () => insertAll('api_keys', (i) => ({ agent_id: e.agentId, key_hash: `hash-${i}`, prefix: 'vk_sort', last_used_at: D[i], expires_at: [null, T3, T3, T1, null, T1][i] })) },
  {
    name: 'connections', nullable: ['last_synced_at'],
    seed: async () => {
      for (const i of ROWS) {
        await ensureConnection(e.binding, e, id(100 + i))
        await e.update('channel_connections', id(100 + i), { created_at: CT[i], updated_at: UT[i] })
        // `last_synced_at` is derived: the mailbox's cursor row, absent until a sync has run (null).
        if (D[i] !== null) await e.insert('mail_sync_cursors', { connection_id: id(100 + i), history_id: String(i + 1), last_synced_at: D[i] })
      }
    },
  },
]

type Row = Record<string, any>
const cmp = (a: unknown, b: unknown) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : (a as any) < (b as any) ? -1 : 1)
const reference = (rows: Row[], sort: string, order: string) =>
  [...rows].sort((a, b) => (cmp(a[sort], b[sort]) || cmp(a.id, b.id)) * (order === 'desc' ? -1 : 1)).map((r) => r.id)
async function page(path: string, query: string, scopes: string[] = ALL) {
  const r = await call(`${path}?${query}`, scopes)
  expect(r.status, `${path}?${query} ${JSON.stringify(r.body)}`).toBe(200)
  return r.body
}
async function walk(path: string, query: string, limit: number): Promise<Row[]> {
  const out: Row[] = []
  let after: string | null = null
  for (let guard = 0; guard < 30; guard++) {
    const p = await page(path, `${query}&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`)
    out.push(...p.data)
    if (p.next_cursor === null) return out
    expect(p.next_cursor, 'sorted cursors are opaque, never a bare UUID').not.toMatch(UUID)
    after = p.next_cursor
  }
  throw new Error('walk did not terminate')
}
async function unsortedRows(path: string): Promise<Row[]> {
  const out: Row[] = []
  let after: string | null = null
  for (let guard = 0; guard < 30; guard++) {
    const p = await page(path, `limit=200${after ? `&after=${after}` : ''}`)
    out.push(...p.data)
    if (p.next_cursor === null) return out
    after = p.next_cursor
  }
  throw new Error('walk did not terminate')
}
const storedSorts = (list: string) => EXPECTED[list]!.filter((s) => !DERIVED.has(s))

for (const spec of specs) {
  describe(`${spec.name} list sort matrix (CORE175 D1, D4, D5)`, () => {
    const path = pathOf(spec.name)
    let rows: Row[] = []
    it('is empty first: every sort and order answers an empty page without a cursor', async () => {
      await e.reset()
      const baseline = (await unsortedRows(path)).length
      if (baseline > 0) return // lists with seeded system rows (memberships) are covered by the populated walks
      for (const sort of storedSorts(spec.name)) for (const order of ['asc', 'desc']) {
        expect(await page(path, `sort=${sort}&order=${order}&limit=1`)).toEqual({ data: [], next_cursor: null })
      }
    })
    it('seeds enough rows with the ties and nulls the column allows', async () => {
      await spec.seed()
      rows = await unsortedRows(path)
      expect(rows.length).toBeGreaterThanOrEqual(5)
      for (const sort of storedSorts(spec.name).filter((s) => s !== 'id')) {
        const values = rows.map((r) => r[sort])
        if (!(spec.unique ?? []).includes(sort)) expect(new Set(values).size, `${sort} has ties`).toBeLessThan(values.length)
        if (spec.nullable.includes(sort)) expect(values.includes(null), `${sort} has nulls`).toBe(true)
        expect(new Set(values).size, `${sort} is not constant`).toBeGreaterThan(1)
      }
    })
    for (const sort of storedSorts(spec.name)) for (const order of ['asc', 'desc']) {
      it(`${sort} ${order}: pages of 1 and 2 equal the reference order, no gaps or repeats`, async () => {
        const expected = reference(rows, sort, order)
        for (const limit of [1, 2]) expect((await walk(path, `sort=${sort}&order=${order}`, limit)).map((r) => r.id), `page size ${limit}`).toEqual(expected)
        expect((await page(path, `sort=${sort}&order=${order}`)).data.map((r: Row) => r.id)).toEqual(expected)
      })
    }
    it('unsorted keeps ascending id and UUID cursors', async () => {
      const first = await page(path, 'limit=1')
      expect(first.data[0].id).toBe([...rows].map((r) => r.id).sort()[0])
      expect(first.next_cursor).toBe(first.data[0].id)
      expect(first.next_cursor).toMatch(UUID)
    })
  })
}

describe('action_requests list sort matrix through its kit (CORE175 D1)', () => {
  let k: ActionKit
  let owner: Actor
  let rows: Row[] = []
  const AR = '/api/v1/action-requests'
  const walkKit = async (query: string, limit: number) => {
    const out: Row[] = []
    let after: string | null = null
    for (let guard = 0; guard < 30; guard++) {
      const r = await k.call(owner, 'GET', `${AR}?${query}&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      out.push(...r.body.data)
      if (r.body.next_cursor === null) return out
      expect(r.body.next_cursor).not.toMatch(UUID)
      after = r.body.next_cursor
    }
    throw new Error('walk did not terminate')
  }
  beforeAll(async () => {
    k = await openActionKit()
    await k.reset()
    owner = k.owner
  })
  afterAll(() => k?.close())
  it('is empty first', async () => {
    for (const sort of EXPECTED.action_requests!) for (const order of ['asc', 'desc']) {
      const r = await k.call(owner, 'GET', `${AR}?sort=${sort}&order=${order}&limit=1`)
      expect([r.status, r.body]).toEqual([200, { data: [], next_cursor: null }])
    }
  })
  it('seeds proposals through the kit: clocks forcing ties, and decided and undecided rows', async () => {
    const proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'action_requests:read'])
    const ids: string[] = []
    for (const [n, at] of [T1, T1, T2, T2, T3, T3].entries()) {
      k.setNow(new Date(at))
      const created = await k.call(proposer, 'POST', AR, { operation: 'tasks.create', arguments: { title: `t${n}` }, reason: 'sort fixture' })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      ids.push(created.body.id)
    }
    for (const [n, at] of [[0, T3], [2, T3], [3, T2]] as const) {
      k.setNow(new Date(at))
      expect((await k.call(owner, 'POST', `${AR}/${ids[n]}/reject`, { decision_reason: 'no' })).status).toBe(200)
    }
    const r = await k.call(owner, 'GET', `${AR}?limit=200`)
    rows = r.body.data
    expect(rows).toHaveLength(6)
    for (const sort of EXPECTED.action_requests!.filter((s) => s !== 'id')) {
      const values = rows.map((x) => x[sort])
      expect(new Set(values).size, `${sort} has ties`).toBeLessThan(values.length)
      expect(new Set(values).size, `${sort} varies`).toBeGreaterThan(1)
    }
    expect(rows.some((x) => x.decided_at === null), 'decided_at has nulls').toBe(true)
  })
  for (const sort of EXPECTED.action_requests!) for (const order of ['asc', 'desc']) {
    it(`${sort} ${order}: pages of 1 and 2 equal the reference order`, async () => {
      for (const limit of [1, 2]) expect((await walkKit(`sort=${sort}&order=${order}`, limit)).map((r) => r.id), `page size ${limit}`).toEqual(reference(rows, sort, order))
    })
  }
})

describe('advertised contracts of every adopted list (CORE175 D2, D5)', () => {
  const guidance = (text: string) => {
    for (const pattern of [/sort=created_at&order=desc/, /not a snapshot/, /complete walk uses the default order/, /incremental/, /ascending id/]) expect(text).toMatch(pattern)
  }
  const rpc = async (method: string, params: unknown) =>
    (await (await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token(ALL)}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any
  it('REST and MCP advertise exactly the D1 sorts, asc/desc, and opaque string cursors for all twenty prepared lists', async () => {
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as any
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const tools = (await rpc('tools/list', {})).result.tools as any[]
    for (const [list, sorts] of Object.entries(EXPECTED)) {
      const get = (doc.paths[pathOf(list)] ?? meta.paths[pathOf(list)]).get
      const params = Object.fromEntries(get.parameters.map((p: any) => [p.name, p])) as any
      expect(params.sort, `${list} advertises sort`).toBeDefined()
      expect(params.sort.schema.enum, list).toEqual(sorts)
      expect(params.order.schema.enum, list).toEqual(['asc', 'desc'])
      expect(params.after.schema.type, list).toBe('string')
      expect(params.after.schema.format, list).toBeUndefined()
      const next = get.responses['200'].content['application/json'].schema.properties.next_cursor
      expect(next.type, list).toEqual(['string', 'null'])
      expect(JSON.stringify(next), list).not.toContain('uuid')
      guidance(params.sort.description ?? params.sort.schema.description)
      const tool = tools.find((t) => t.name === `${list}_list`)
      expect(tool, `${list}_list is an MCP tool`).toBeDefined()
      expect(tool.inputSchema.properties.sort.enum, list).toEqual(sorts)
      expect(tool.inputSchema.properties.order.enum, list).toEqual(['asc', 'desc'])
      expect(tool.inputSchema.properties.after.type, list).toBe('string')
      expect(tool.inputSchema.properties.after.format, list).toBeUndefined()
      expect(tool.outputSchema.properties.next_cursor.type, list).toEqual(['string', 'null'])
      guidance(tool.inputSchema.properties.sort.description)
    }
  })
  it('the two hand-written lists left out by design (associations, users) keep ascending id and UUID cursors, with no sort parameter', async () => {
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as any
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const tools = (await rpc('tools/list', {})).result.tools as any[]
    for (const list of ['associations', 'users']) {
      const get = (doc.paths[pathOf(list)] ?? meta.paths[pathOf(list)]).get
      const names = get.parameters.map((p: any) => p.name)
      expect(names, list).not.toContain('sort')
      expect(names, list).not.toContain('order')
      expect(get.parameters.find((p: any) => p.name === 'after').schema.format, list).toBe('uuid')
      const tool = tools.find((t) => t.name === `${list}_list`)
      expect(tool.inputSchema.properties.sort, list).toBeUndefined()
      expect(tool.inputSchema.properties.after.format, list).toBe('uuid')
    }
  })
})

describe('authority, errors and compatibility of newly adopted sorts (CORE175 D5, D8)', () => {
  it('a caller with only tasks:read sorts a stored column and gets the reference order', async () => {
    await e.reset()
    await insertAll('tasks', (i) => ({ title: N[i], due_at: D[i] }))
    const rows = await unsortedRows('/api/v1/tasks')
    const sorted = await page('/api/v1/tasks', 'sort=due_at&order=desc', ['tasks:read'])
    expect(sorted.data.map((r: Row) => r.id)).toEqual(reference(rows, 'due_at', 'desc'))
    const none = await call('/api/v1/tasks?sort=due_at', [])
    expect([none.status, none.body.error.code]).toEqual([403, 'insufficient_scope'])
  })
  it('contacts: a stored sort needs only contacts:read, a derived sort still answers 403 insufficient_scope', async () => {
    await e.reset()
    await insertAll('contacts', (i) => ({ name: S[i] }))
    const rows = await unsortedRows('/api/v1/contacts')
    expect((await page('/api/v1/contacts', 'sort=name', ['contacts:read'])).data.map((r: Row) => r.id)).toEqual(reference(rows, 'name', 'asc'))
    for (const sort of ['last_contacted_at', 'last_interacted_at']) {
      const denied = await call(`/api/v1/contacts?sort=${sort}`, ['contacts:read'])
      expect([denied.status, denied.body.error.code], sort).toEqual([403, 'insufficient_scope'])
      expect((await call(`/api/v1/contacts?sort=${sort}`, ['contacts:read', 'interactions:read'])).status, sort).toBe(200)
    }
  })
  it('a malformed cursor is 400 validation_error: integer sort, sort=id, and a cursor of another sort', async () => {
    await e.reset()
    await e.insert('pipelines', { id: id(1), name: 'P' })
    await insertAll('pipeline_stages', (i) => ({ pipeline_id: id(1), name: `s${i}`, kind: 'open', position: i }))
    const envelope = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const first = await page('/meta/v1/pipeline-stages', 'sort=position&limit=1')
    const bad = [
      'sort=position&after=!!!', `sort=position&after=${envelope(['position', 'asc', 'two', id(100)])}`, `sort=position&after=${envelope(['position', 'asc', 1.5, id(100)])}`,
      `sort=name&after=${first.next_cursor}`, `sort=position&order=desc&after=${first.next_cursor}`, `after=${first.next_cursor}`,
      'sort=id&after=not-a-uuid', `sort=id&after=${envelope(['id', 'asc', 'not-a-uuid', 'not-a-uuid'])}`, `sort=id&after=${envelope(['id', 'asc', id(101), id(100)])}`, 'order=desc',
    ]
    for (const q of bad) {
      const r = await call(`/meta/v1/pipeline-stages?${q}`)
      expect([r.status, r.body.error?.code], q).toEqual([400, 'validation_error'])
    }
    expect((await page('/meta/v1/pipeline-stages', `sort=position&after=${first.next_cursor}&limit=1`)).data).toHaveLength(1)
  })
  it('sorted reads emit no events and unsorted UUID walks are unchanged', async () => {
    await e.reset()
    await insertAll('tasks', (i) => ({ title: N[i], due_at: D[i] }))
    const before = await e.events()
    await walk('/api/v1/tasks', 'sort=title&order=desc', 1)
    expect(await e.events()).toEqual(before)
    const first = await page('/api/v1/tasks', 'limit=2')
    expect(first.next_cursor).toBe(first.data[1].id)
    const rest = await page('/api/v1/tasks', `limit=50&after=${first.next_cursor}`)
    expect([...first.data, ...rest.data].map((r: Row) => r.id)).toEqual((await e.rows('tasks')).map((r) => r.id).sort())
    expect((await call('/api/v1/tasks?after=not-a-uuid')).body.error.code).toBe('validation_error')
  })
})
