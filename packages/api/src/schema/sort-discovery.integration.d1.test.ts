import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { fullPath, type Surface } from '../surfaces.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { STATED_SORT_COSTS } from '../storage/sort-costs.js'
import { schemaDocument } from './document.js'

// [[CORE187]] D10, D16, D17: `schema.get` describes each list's sorts. A real D1, the real router, the real MCP handler. The expected values
// are taken from the list operation's own advertised `sort` enum (OpenAPI), never from the definition the builder reads, and the stated
// costs are written out below as literals for the spot checks.
let e: Engine
let app: ReturnType<typeof createApp>
const registry = createVaultRegistry()
const ALL = registry.declaredScopes()
beforeAll(async () => {
  e = await openD1Engine()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => {
  await e?.close()
})

const token = (scopes: string[]) => mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })
const bearer = (scopes: string[] = ['schema:read']) => ({ authorization: `Bearer ${token(scopes)}` })
const rest = async () => {
  const res = await app.request('/meta/v1/schema', { headers: bearer() })
  return { status: res.status, body: (await res.json()) as any }
}
const mcp = async (scopes: string[] = ['schema:read']) => {
  const res = await app.request('/mcp', { method: 'POST', headers: { ...bearer(scopes), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'schema_get', arguments: {} } }) })
  return (await res.json()) as any
}
const tableOf = (doc: any, name: string) => doc.tables.find((t: any) => t.name === name)
const pathOf = (list: string) => fullPath(registry.get(`${list}.list`) as { surface: Surface; path: string })
/** The values the list's `sort` parameter accepts, from OpenAPI; [] when the list has no sort parameter. */
async function advertised(list: string): Promise<string[]> {
  const doc = (await (await app.request('/api/v1/openapi.json')).json()) as any
  const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
  const get = (doc.paths[pathOf(list)] ?? meta.paths[pathOf(list)]).get
  return get.parameters.find((p: any) => p.name === 'sort')?.schema.enum ?? []
}
const resourceTables = (doc: any) => doc.tables.filter((t: any) => t.resource !== null)
const stated = (list: string, sort: string) => STATED_SORT_COSTS.some((c) => c.list === list && c.sort === sort)

describe('sorts agree with the list, for every resource (CORE187 D10, D16)', () => {
  it('there is a resource object for every registered resource that has a list, and each carries sorts', async () => {
    const doc = (await rest()).body
    const withList = registry.resources().filter((d) => registry.get(`${d.name}.list`)).map((d) => d.name).sort()
    expect(withList.length).toBeGreaterThanOrEqual(21)
    expect(resourceTables(doc).map((t: any) => t.resource.name).filter((n: string) => withList.includes(n)).sort()).toEqual(withList)
    for (const t of resourceTables(doc)) expect(Array.isArray(t.resource.sorts), `${t.name}.resource.sorts`).toBe(true)
  })
  it('names equal, in order, what the list accepts, and every kind is a sortable kind (the matrix)', async () => {
    const doc = (await rest()).body
    let checked = 0
    for (const t of resourceTables(doc)) {
      if (!registry.get(`${t.resource.name}.list`)) continue
      const accepted = await advertised(t.resource.name)
      expect(t.resource.sorts.map((s: any) => s.name), t.resource.name).toEqual(accepted)
      for (const s of t.resource.sorts) expect(['timestamp', 'uuid', 'text', 'integer'], `${t.resource.name}.${s.name}`).toContain(s.kind)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(21)
  })
  it('each kind is the column kind (or the derived field kind) of that sort', async () => {
    const doc = (await rest()).body
    for (const t of resourceTables(doc)) {
      for (const s of t.resource.sorts) {
        const col = t.columns.find((c: any) => c.name === s.name)
        const derived = t.derived.find((d: any) => d.name === s.name)
        expect(s.kind, `${t.name}.${s.name}`).toBe((col ?? derived).kind)
      }
    }
  })
  it('spot literals: messages starts id, created_at, occurred_at; contacts ends with its two derived sorts, timestamp kind', async () => {
    const doc = (await rest()).body
    expect(tableOf(doc, 'messages').resource.sorts.slice(0, 3)).toEqual([
      { name: 'id', kind: 'uuid', indexed: true },
      { name: 'created_at', kind: 'timestamp', indexed: false },
      { name: 'occurred_at', kind: 'timestamp', indexed: true },
    ])
    expect(tableOf(doc, 'contacts').resource.sorts.slice(-2)).toEqual([
      { name: 'last_contacted_at', kind: 'timestamp', indexed: false },
      { name: 'last_interacted_at', kind: 'timestamp', indexed: false },
    ])
  })
})

describe('indexed is the plan fact (CORE187 D16)', () => {
  it('every entry has indexed === not stated(list, sort)', async () => {
    const doc = (await rest()).body
    let n = 0
    for (const t of resourceTables(doc)) {
      for (const s of t.resource.sorts) {
        expect(s.indexed, `${t.resource.name}.${s.name}`).toBe(!stated(t.resource.name, s.name))
        n++
      }
    }
    expect(n).toBeGreaterThan(60)
  })
  it('literals: messages.occurred_at and tasks.id are indexed; messages.created_at, contacts.name, contacts.last_contacted_at, contact_files.id are not', async () => {
    const doc = (await rest()).body
    const entry = (table: string, sort: string) => tableOf(doc, table).resource.sorts.find((s: any) => s.name === sort)
    expect(entry('messages', 'occurred_at').indexed).toBe(true)
    expect(entry('tasks', 'id').indexed).toBe(true)
    expect(entry('messages', 'created_at').indexed).toBe(false)
    expect(entry('contacts', 'name').indexed).toBe(false)
    expect(entry('contacts', 'last_contacted_at').indexed).toBe(false)
    expect(entry('contact_files', 'id').indexed).toBe(false)
  })
})

describe('empty and absent (CORE187 D15, D16)', () => {
  it('action_executions is a resource with sorts: [], and its list advertises no sort', async () => {
    const doc = (await rest()).body
    expect(tableOf(doc, 'action_executions').resource).not.toBeNull()
    expect(tableOf(doc, 'action_executions').resource.sorts).toEqual([])
    expect(await advertised('action_executions')).toEqual([])
  })
  it('associations and users keep resource null and the top-level associations block is unchanged', async () => {
    const doc = (await rest()).body
    expect(tableOf(doc, 'associations').resource).toBeNull()
    expect(tableOf(doc, 'users').resource).toBeNull()
    expect(Object.keys(doc.associations)).toEqual(['table', 'relations', 'associable', 'description'])
    expect(Object.keys(doc)).toEqual(['engine', 'kinds', 'tables', 'associations'])
  })
  it('no resource object lacks sorts', async () => {
    for (const t of resourceTables((await rest()).body)) expect(t.resource, t.name).toHaveProperty('sorts')
  })
})

describe('derived sortable and columns unchanged (CORE187 D10)', () => {
  it('for every derived field of every table, sortable === the table\'s sorts include it', async () => {
    const doc = (await rest()).body
    let n = 0
    for (const t of doc.tables) {
      for (const d of t.derived) {
        const names = (t.resource?.sorts ?? []).map((s: any) => s.name)
        expect(d.sortable, `${t.name}.${d.name}`).toBe(names.includes(d.name))
        n++
      }
    }
    expect(n).toBeGreaterThanOrEqual(4)
  })
  it('contacts: both derived true; deals.status false', async () => {
    const doc = (await rest()).body
    expect(tableOf(doc, 'contacts').derived.map((d: any) => [d.name, d.sortable])).toEqual([['last_contacted_at', true], ['last_interacted_at', true]])
    expect(tableOf(doc, 'deals').derived.find((d: any) => d.name === 'status').sortable).toBe(false)
  })
  it('column objects keep exactly their API63 keys', async () => {
    for (const t of (await rest()).body.tables) {
      for (const c of t.columns) expect(Object.keys(c), `${t.name}.${c.name}`).toEqual(['name', 'type', 'kind', 'nullable', 'primary_key', 'default', 'label', 'description', 'values', 'exposed', 'references'])
    }
  })
  it('a resource object has exactly the API63 keys then sorts', async () => {
    expect(Object.keys(tableOf((await rest()).body, 'tasks').resource)).toEqual(['name', 'surface', 'path', 'operations', 'read_scope', 'write_scope', 'sorts'])
  })
})

describe('wire contract (CORE187 D10, D17)', () => {
  it('REST validates against the document schema and carries sorts; the document is the same for a caller with more scopes (no requires, D17)', async () => {
    const r = await rest()
    expect(r.status).toBe(200)
    const doc = schemaDocument.parse(r.body)
    expect(doc.tables.find((t) => t.name === 'messages')!.resource!.sorts.map((s) => s.name)).toEqual(['id', 'created_at', 'occurred_at'])
    const wide = await app.request('/meta/v1/schema', { headers: bearer(['schema:read', ...ALL]) })
    expect(await wide.json()).toEqual(r.body)
  })
  it('the response schema keeps `sorts` when parsing (strip would lose it)', () => {
    const shape = (schemaDocument.shape.tables.element.shape.resource.unwrap() as any).shape
    expect(Object.keys(shape)).toContain('sorts')
  })
  it('MCP schema_get returns the same document, and it validates and carries sorts', async () => {
    const response = await mcp()
    const result = response.result.structuredContent
    const doc = schemaDocument.parse(result)
    expect(doc.tables.find((t) => t.name === 'contacts')!.resource!.sorts.at(-1)).toEqual({ name: 'last_interacted_at', kind: 'timestamp', indexed: false })
    expect(result).toEqual((await rest()).body)
  })
  it('the meta OpenAPI document describes sorts on the schema response', async () => {
    const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
    const text = JSON.stringify(meta.paths['/meta/v1/schema'].get.responses['200'])
    expect(text).toContain('"sorts"')
    expect(text).toContain('"indexed"')
  })
})
