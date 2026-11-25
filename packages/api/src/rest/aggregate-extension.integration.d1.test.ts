import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineCustomObject } from '../custom/resource.js'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from './app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { createCustomTables, PROJECTS_KEY, PROJECTS_REFS } from '../test/custom-objects.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[DX616]] D1: every `<name>.aggregate` operation in the api OpenAPI document carries `x-vibase-aggregate`, the same object `schema.get` publishes
// as `resource.aggregate`; no other operation carries it, and the MCP tool list does not see it.
const registry = createVibaseRegistry({ definitions: [defineCustomObject(PROJECTS_KEY, PROJECTS_REFS)] })
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
  await createCustomTables(e.d1!, PROJECTS_KEY, PROJECTS_REFS)
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
afterAll(async () => {
  await e?.close()
})
const token = () =>
  mintTestUserToken({
    userId: e.agentId,
    organizationId: e.organizationId,
    scopes: registry.declaredScopes(),
    kind: 'agent',
  })
const get = async (path: string) => {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token()}` } })
  return (await res.json()) as any
}

describe('x-vibase-aggregate (D1)', () => {
  it('every aggregate operation carries the schema.get spec of its list, and nothing else carries one', async () => {
    const doc = await (await app.request('/api/v1/openapi.json')).json()
    const schema = await get('/meta/v1/schema')
    const ops: Record<string, any> = {}
    for (const item of Object.values<any>(doc.paths))
      for (const op of Object.values<any>(item)) if (op?.operationId) ops[op.operationId] = op
    const carriers = Object.keys(ops).filter((id) => ops[id]['x-vibase-aggregate'] !== undefined)
    expect(carriers.sort()).toEqual(
      [
        `contacts.aggregate`,
        'companies.aggregate',
        'deals.aggregate',
        'tasks.aggregate',
        `${PROJECTS_KEY}.aggregate`,
      ].sort(),
    )
    for (const id of carriers) {
      const list = id.slice(0, -'.aggregate'.length)
      const table = schema.tables.find((t: any) => t.name === list)
      expect(table.resource.aggregate, id).not.toBeNull()
      expect(ops[id]['x-vibase-aggregate'], id).toEqual(table.resource.aggregate)
    }
    // the three shapes the SDK relies on: money, an empty function list, a defined custom object
    expect(ops['deals.aggregate']['x-vibase-aggregate'].money).toEqual({ amount_minor: 'currency' })
    expect(ops['tasks.aggregate']['x-vibase-aggregate'].sum).toEqual([])
    expect(ops[`${PROJECTS_KEY}.aggregate`]['x-vibase-aggregate'].group_by.length).toBeGreaterThan(0)
  })
  it('the MCP tool list does not carry it', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(JSON.stringify(await res.json())).not.toContain('x-vibase-aggregate')
  })
})
