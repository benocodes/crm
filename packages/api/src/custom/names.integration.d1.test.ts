import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLUMN_KINDS } from '@vibase/storage'
import { readFileSync, readdirSync } from 'node:fs'
import { MIGRATIONS_DIR } from '@vibase/storage-d1/test'
import { createVibaseRegistry } from '../operations.js'
import { deriveTools } from '../mcp/tools.js'
import { resourcePath } from '../resources/define.js'
import { d1Backend } from '../test/d1-backend.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '../test/custom-objects.js'

// [[CORE315]] D9, D25: a `__c` name is never translated: the REST path, the OpenAPI document, the MCP tools and the operation names say `projects__c`, where a plain resource name turns `_` into `-`.
const registry = createVibaseRegistry({ definitions: [projectsDefinition()] })
const ALL = registry.declaredScopes()
let s: ContractSession
let a: ContractTenant
beforeAll(async () => {
  s = await d1Backend({ setup: (d1) => createCustomTables(d1) }).open(registry)
  ;({ a } = await s.reset())
})
afterAll(() => s.close())

describe('REST', () => {
  it('the path is /api/v1/<key>__c, in the OpenAPI document and served; a plain name still turns _ into -', async () => {
    const doc = (await (await s.app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(doc.paths)
    expect(paths).toContain(`/api/v1/${PROJECTS_KEY}`)
    expect(paths).toContain(`/api/v1/${PROJECTS_KEY}/{id}`)
    expect(paths.filter((p) => p.includes('--c'))).toEqual([])
    const meta = (await (await s.app.request('/meta/v1/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(meta.paths)).toContain('/meta/v1/blocked-senders')
    expect(resourcePath({ name: PROJECTS_KEY })).toBe(`/${PROJECTS_KEY}`)
    expect(resourcePath({ name: 'blocked_senders' })).toBe('/blocked-senders')
    const made = await s.call(a, 'user', ALL, 'POST', `/api/v1/${PROJECTS_KEY}`, { name: 'x' })
    expect(made.status).toBe(201)
    expect((await s.call(a, 'user', ALL, 'GET', '/api/v1/projects--c')).status).toBe(404)
  })

  it('the operations are named <key>__c.<action>', () => {
    const names = registry
      .operations()
      .map((o) => o.name)
      .filter((n) => n.startsWith(PROJECTS_KEY))
    expect(names.sort()).toEqual(
      ['aggregate', 'create', 'delete', 'get', 'list', 'property_keys', 'update']
        .map((x) => `${PROJECTS_KEY}.${x}`)
        .sort(),
    )
  })
})

describe('MCP', () => {
  it('the tools are <key>__c_<action> and a call works', async () => {
    const names = deriveTools(registry).map((t) => t.tool.name)
    for (const action of ['list', 'get', 'create', 'update', 'delete'])
      expect(names).toContain(`${PROJECTS_KEY}_${action}`)
    const rpc = async (method: string, params: unknown = {}) =>
      (await (await s.call(a, 'user', ALL, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params })).json()) as any
    const listed = (await rpc('tools/list')).result.tools.map((t: any) => t.name)
    expect(listed).toContain(`${PROJECTS_KEY}_create`)
    const made = await rpc('tools/call', { name: `${PROJECTS_KEY}_create`, arguments: { name: 'By tool' } })
    expect(made.result.isError, JSON.stringify(made)).not.toBe(true)
    const got = await rpc('tools/call', { name: `${PROJECTS_KEY}_list`, arguments: {} })
    expect(JSON.stringify(got)).toContain('By tool')
  })
})

describe('no core table or column ends in __c (D9)', () => {
  it('the storage layer declares none', () => {
    const offenders = Object.entries(COLUMN_KINDS).flatMap(([table, kinds]) =>
      [table, ...Object.keys(kinds)].filter((n) => n.endsWith('__c')).map((n) => `${table}.${n}`),
    )
    expect(offenders).toEqual([])
  })
  it('no D1 migration names one', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(files.length).toBeGreaterThan(20)
    const offenders = files.filter((f) => /__c\b/.test(readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf-8')))
    expect(offenders).toEqual([])
  })
})
