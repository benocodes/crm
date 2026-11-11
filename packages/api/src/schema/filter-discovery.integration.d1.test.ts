import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { fullPath, type Surface } from '../surfaces.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { STATED_FILTER_COSTS } from '../storage/filter-costs.js'
import { tasks } from '../resources/tasks.js'
import { buildSchemaDocument } from './build.js'
import { schemaDocument } from './document.js'

// [[CORE201]] D11, D12: `schema.get` describes each list's filters. A real D1, the real router. The expected values come from the list operation's own
// OpenAPI parameters and from the D3 operator table written out here as literals, never from the definition the builder reads.
let e: Engine
let app: ReturnType<typeof createApp>
const registry = createVaultRegistry()
beforeAll(async () => {
  e = await openD1Engine()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => {
  await e?.close()
})
const token = (scopes: string[]) => mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })
const rest = async () => {
  const res = await app.request('/meta/v1/schema', { headers: { authorization: `Bearer ${token(['schema:read'])}` } })
  return { status: res.status, body: (await res.json()) as any }
}
const tableOf = (doc: any, name: string) => doc.tables.find((t: any) => t.name === name)
const resourceTables = (doc: any) => doc.tables.filter((t: any) => t.resource !== null)
const pathOf = (list: string) => fullPath(registry.get(`${list}.list`) as { surface: Surface; path: string })
const OPERATORS: Record<string, string[]> = {
  uuid: ['eq', 'neq', 'in'],
  text: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'ilike'],
  integer: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'],
  timestamp: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'],
  boolean: ['eq', 'neq'],
}
/** The D3 table for a kind, with `is` last where the field can be null. */
const expectedOperators = (kind: string, nullable: boolean) => [...OPERATORS[kind]!, ...(nullable ? ['is'] : [])]
const stated = (list: string, filter: string) => STATED_FILTER_COSTS.some((c) => c.list === list && c.filter === filter)
async function advertised(list: string): Promise<string[]> {
  const doc = (await (await app.request('/api/v1/openapi.json')).json()) as any
  const meta = (await (await app.request('/meta/v1/openapi.json')).json()) as any
  const get = (doc.paths[pathOf(list)] ?? meta.paths[pathOf(list)]).get
  return (get.parameters as any[]).map((p) => p.name as string).filter((n) => !['after', 'limit', 'sort', 'order'].includes(n))
}

describe('filters agree with the list, for every resource (CORE201 D11)', () => {
  it('the document still parses, and every resource that has a list carries filters equal, as a set, to the list\'s parameters', async () => {
    const doc = (await rest()).body
    expect(() => schemaDocument.parse(doc)).not.toThrow()
    let checked = 0
    for (const t of resourceTables(doc)) {
      if (!registry.get(`${t.resource.name}.list`)) continue
      expect(Array.isArray(t.resource.filters), `${t.name}.resource.filters`).toBe(true)
      expect(t.resource.filters.map((f: any) => f.name).sort(), t.resource.name).toEqual((await advertised(t.resource.name)).sort())
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(21)
  })
  it('column filters come first in record field order, then custom filters; each has the stated shape (the matrix)', async () => {
    const doc = (await rest()).body
    let columns = 0
    for (const t of resourceTables(doc)) {
      if (!registry.get(`${t.resource.name}.list`)) continue
      const fs = t.resource.filters as any[]
      const firstCustom = fs.findIndex((f) => f.custom)
      expect(fs.slice(firstCustom === -1 ? fs.length : firstCustom).every((f) => f.custom), `${t.name} custom last`).toBe(true)
      const fields = t.columns.filter((c: any) => c.exposed).map((c: any) => c.name)
      const own = fs.filter((f) => !f.custom)
      expect(own.map((f) => f.name), `${t.name} record order`).toEqual(fields.filter((n: string) => own.some((f) => f.name === n)))
      for (const f of fs) {
        expect(typeof f.description, `${t.name}.${f.name}`).toBe('string')
        expect(f.description.length, `${t.name}.${f.name}`).toBeGreaterThan(10)
        if (f.custom) {
          expect({ kind: f.kind, operators: f.operators, indexed: f.indexed }, `${t.name}.${f.name}`).toEqual({ kind: null, operators: [], indexed: null })
          continue
        }
        columns++
        const col = t.columns.find((c: any) => c.name === f.name)
        expect(f.kind, `${t.name}.${f.name}`).toBe(col.kind)
        expect(f.operators, `${t.name}.${f.name}`).toEqual(expectedOperators(col.kind, col.nullable))
        expect(f.indexed, `${t.name}.${f.name}`).toBe(!stated(t.resource.name, f.name))
      }
    }
    expect(columns).toBeGreaterThan(100)
  })
  it('spot literals: tasks (generic), deals (custom filters), contacts (activity filters)', async () => {
    const doc = (await rest()).body
    const tasksFilters = tableOf(doc, 'tasks').resource.filters
    expect(tasksFilters.slice(0, 3).map((f: any) => [f.name, f.kind, f.operators, f.custom])).toEqual([
      ['id', 'uuid', ['eq', 'neq', 'in'], false],
      ['title', 'text', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'ilike'], false],
      ['notes', 'text', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'ilike', 'is'], false],
    ])
    expect(tasksFilters.map((f: any) => f.name)).toEqual(['id', 'title', 'notes', 'status', 'due_at', 'completed_at', 'assignee_id', 'created_by', 'created_at', 'updated_at', 'tag_id', 'tag'])
    expect(tasksFilters.find((f: any) => f.name === 'id').indexed).toBe(true)
    expect(tasksFilters.find((f: any) => f.name === 'title').indexed).toBe(false)
    expect(tableOf(doc, 'deals').resource.filters.filter((f: any) => f.custom).map((f: any) => f.name)).toEqual(['status', 'tag_id', 'tag', 'company_id', 'contact_id'])
    const contacts = tableOf(doc, 'contacts').resource.filters.filter((f: any) => f.custom).map((f: any) => f.name)
    expect(contacts.slice(-6)).toEqual(['contacted_since', 'not_contacted_since', 'never_contacted', 'interacted_since', 'not_interacted_since', 'never_interacted'])
    expect(contacts).toContain('tag')
  })
  it('exempt hand-written lists carry no resource object, so no filters; derived fields keep their filters list', async () => {
    const doc = (await rest()).body
    expect(resourceTables(doc).map((t: any) => t.resource.name)).not.toContain('associations')
    expect(resourceTables(doc).map((t: any) => t.resource.name)).not.toContain('users')
    expect(tableOf(doc, 'contacts').derived.find((d: any) => d.name === 'last_contacted_at').filters).toEqual(['contacted_since', 'not_contacted_since', 'never_contacted'])
    expect(tableOf(doc, 'deals').derived.find((d: any) => d.name === 'status').filters).toEqual(['status'])
  })
})

describe('indexed follows STATED_FILTER_COSTS (D12), as a pure builder', () => {
  const column = { table_name: 'tasks', cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 }
  const build = (statedFilterCosts: { list: string; filter: string }[]) =>
    tableOf(buildSchemaDocument({ columns: [column], foreignKeys: [], resources: [tasks as never], statedFilterCosts }), 'tasks').resource.filters as Array<{ name: string; indexed: boolean | null }>
  it('a listed filter is not indexed, an unlisted one is, and dropping the entry flips it', () => {
    const listed = build([{ list: 'tasks', filter: 'title' }])
    expect(listed.find((f) => f.name === 'title')!.indexed).toBe(false)
    expect(listed.find((f) => f.name === 'status')!.indexed).toBe(true)
    expect(build([]).find((f) => f.name === 'title')!.indexed).toBe(true)
  })
  it('the default is the checked-in list', () => {
    const doc = buildSchemaDocument({ columns: [column], foreignKeys: [], resources: [tasks as never] })
    const f = tableOf(doc, 'tasks').resource.filters as Array<{ name: string; indexed: boolean | null }>
    for (const x of f.filter((y) => y.indexed !== null)) expect(x.indexed, x.name).toBe(!stated('tasks', x.name))
  })
})
