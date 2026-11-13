import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { schemaDocument } from '../schema/document.js'

// [[CORE188]] D2: the three times are named where an agent reads them: the record's field descriptions, the list's `sort` parameter (OpenAPI,
// MCP, and through them the CLI's help) and the catalog text `schema.get` serves. Every other list's sort text stays as it was.
let e: Engine
let app: ReturnType<typeof createApp>
const registry = createVibaseRegistry()
const ALL = registry.declaredScopes()
beforeAll(async () => {
  e = await openD1Engine()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => {
  await e?.close()
})
const bearer = (scopes: string[] = ALL) => ({ authorization: `Bearer ${mintTestUserToken({ userId: e.agentId, organizationId: e.organizationId, scopes, kind: 'agent' })}` })
const openapi = async () => (await (await app.request('/api/v1/openapi.json')).json()) as any
const tool = async (name: string) => {
  const r = (await (await app.request('/mcp', { method: 'POST', headers: { ...bearer(), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json()) as any
  return r.result.tools.find((t: any) => t.name === name)
}
/** The shared text of a sort parameter (CORE133 D9, CORE170 D2), spelled out: a list with no list-specific note carries exactly this. */
const shared = (sorts: string) =>
  `Sort by ${sorts}. Stored columns need only this list's read scope; derived fields need the scopes that show them. null sorts as the lowest value: first in asc, last in desc. Ties break on id in the same direction. ` +
  `Newest first: sort=created_at&order=desc; for mail use sort=occurred_at&order=desc. Without sort the list is in ascending id order with UUID cursors. ` +
  `Paging is by keyset, not a snapshot: values can rise between pages (or fall), so a record may repeat in asc or be missed in desc. In descending mail date order, newly arrived mail ahead of the cursor is not seen; backfilled older mail behind it is. ` +
  `A complete walk uses the default order. An incremental walk also uses the default ascending id order. Mail created_at uses a temporary sort over the workspace's rows; id is indexed and follows capture order.`
const NOTE = [/queued at/i, /executed at/i, /done or failed/i, /unfinished/i, /sort=done_at&order=desc/, /decided_at/, /approved at/i, /updated_at/]
const sortParam = (doc: any, path: string) => doc.paths[path].get.parameters.find((p: any) => p.name === 'sort')
const recordOf = (doc: any) => {
  const items = doc.paths['/api/v1/action-executions'].get.responses['200'].content['application/json'].schema.properties.data.items
  return items.properties
}

describe('the sort note and the field descriptions reach every surface (CORE188 D2)', () => {
  it('OpenAPI: the action_executions sort parameter is the shared text plus the note naming the three times', async () => {
    const p = sortParam(await openapi(), '/api/v1/action-executions')
    const text = String(p.description ?? p.schema.description)
    expect(text.startsWith(shared('id or created_at or updated_at or done_at'))).toBe(true)
    for (const pattern of NOTE) expect(text, String(pattern)).toMatch(pattern)
    expect(p.schema.enum).toEqual(['id', 'created_at', 'updated_at', 'done_at'])
  })
  it('OpenAPI: the record schema describes created_at as queued at and done_at as executed at', async () => {
    const props = recordOf(await openapi())
    expect(props.created_at.description).toMatch(/queued/i)
    expect(props.created_at.description).toMatch(/decided_at/)
    expect(props.done_at.description).toMatch(/executed|finished/i)
    expect(props.done_at.description).toMatch(/done or failed/i)
    expect(props.done_at.description).toMatch(/null/)
  })
  it('MCP: the tool input schema carries the note on sort and the enum, and the output record carries the two descriptions', async () => {
    const t = await tool('action_executions_list')
    const sort = t.inputSchema.properties.sort
    for (const pattern of NOTE) expect(sort.description, String(pattern)).toMatch(pattern)
    expect(sort.enum).toEqual(['id', 'created_at', 'updated_at', 'done_at'])
    expect(t.inputSchema.properties.order.enum).toEqual(['asc', 'desc'])
    expect(t.inputSchema.properties.after.type).toBe('string')
    expect(t.inputSchema.properties.after.format).toBeUndefined()
    expect(t.outputSchema.properties.next_cursor.type).toEqual(['string', 'null'])
    const rec = t.outputSchema.properties.data.items.properties
    expect(rec.created_at.description).toMatch(/queued/i)
    expect(rec.done_at.description).toMatch(/executed|finished/i)
  })
  it('OpenAPI and MCP type after and next_cursor as opaque strings, not UUIDs', async () => {
    const doc = await openapi()
    const after = doc.paths['/api/v1/action-executions'].get.parameters.find((p: any) => p.name === 'after')
    expect(after.schema.type).toBe('string')
    expect(after.schema.format).toBeUndefined()
    const next = doc.paths['/api/v1/action-executions'].get.responses['200'].content['application/json'].schema.properties.next_cursor
    expect(next.type).toEqual(['string', 'null'])
    expect(JSON.stringify(next)).not.toContain('uuid')
  })
  it('another list\'s sort text is byte-identical to before: no note leaks onto it', async () => {
    const doc = await openapi()
    const tasks = sortParam(doc, '/api/v1/tasks')
    expect(String(tasks.description ?? tasks.schema.description)).toBe(shared('id or created_at or updated_at or due_at or title'))
    for (const path of ['/api/v1/action-requests', '/api/v1/contacts', '/api/v1/messages']) {
      const text = String(sortParam(doc, path).description ?? sortParam(doc, path).schema.description)
      for (const pattern of [/queued at/i, /executed at/i, /done or failed/i]) expect(text, `${path} ${pattern}`).not.toMatch(pattern)
      expect(text.startsWith('Sort by ')).toBe(true)
      expect(text.endsWith("id is indexed and follows capture order.")).toBe(true)
    }
  })
  it('discovery: the catalog text names the three times', async () => {
    const res = await app.request('/meta/v1/schema', { headers: bearer(['schema:read']) })
    const doc = schemaDocument.parse(await res.json()) as any
    const col = (table: string, name: string) => doc.tables.find((t: any) => t.name === table).columns.find((c: any) => c.name === name)
    expect(col('action_executions', 'created_at').description).toMatch(/queued/i)
    expect(col('action_executions', 'created_at').description).toMatch(/decided_at/)
    expect(col('action_executions', 'done_at').description).toMatch(/executed|finished/i)
    expect(col('action_executions', 'done_at').description).toMatch(/done or failed/i)
    expect(col('action_requests', 'decided_at').description).toMatch(/approved at/i)
    expect(col('action_requests', 'decided_at').description).toMatch(/queued/i)
  })
})
