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
import { applySchemaFile } from './apply.js'
import { defineCustomObject } from './resource.js'
import type { ObjectDeclaration } from './declaration.js'

// [[CORE692]] D1, D2: a custom object's semantic part follows each surface's case convention (REST: `_` becomes `-`) and its `__c` suffix is kept verbatim; the stored name, the operation ids, the MCP tools, the scopes, the events and every wire name keep the snake `__c` name.
const MULTI_KEY = 'session_recordings__c'
const MULTI_PATH = '/api/v1/session-recordings__c'
const MULTI: ObjectDeclaration = {
  label: 'Session recordings',
  fields: { title: { kind: 'text', required: true }, length_seconds: { kind: 'integer' } },
}
const EXTEND = { contacts: { referral_source__c: { kind: 'text' as const } } }
const registry = createVibaseRegistry({
  definitions: [projectsDefinition(), defineCustomObject(MULTI_KEY, MULTI)],
  extend: EXTEND,
})
const ALL = registry.declaredScopes()
let s: ContractSession
let a: ContractTenant
beforeAll(async () => {
  s = await d1Backend({
    setup: async (d1) => {
      await createCustomTables(d1)
      await createCustomTables(d1, MULTI_KEY, MULTI)
      const r = await applySchemaFile(d1, {}, EXTEND)
      if (r.refused.length > 0) throw new Error(JSON.stringify(r.refused))
    },
  }).open(registry)
  ;({ a } = await s.reset())
})
afterAll(() => s.close())

describe('REST', () => {
  it('a multi-word object is served at /api/v1/<kebab stem>__c, in the OpenAPI document and the routes; the old snake path is a 404', async () => {
    const doc = (await (await s.app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(doc.paths)
    expect(paths).toContain(MULTI_PATH)
    expect(paths).toContain(`${MULTI_PATH}/{id}`)
    expect(paths).not.toContain(`/api/v1/${MULTI_KEY}`)
    expect(paths.filter((p) => p.includes('--c') || p.includes('session_'))).toEqual([])
    const made = await s.call(a, 'user', ALL, 'POST', MULTI_PATH, { title: 'Call 1' })
    expect(made.status).toBe(201)
    const id = ((await made.json()) as { id: string }).id
    const got = await s.call(a, 'user', ALL, 'GET', `${MULTI_PATH}/${id}`)
    expect(got.status).toBe(200)
    expect(((await got.json()) as { title: string }).title).toBe('Call 1')
    expect((await s.call(a, 'user', ALL, 'GET', `/api/v1/${MULTI_KEY}`)).status).toBe(404)
    expect((await s.call(a, 'user', ALL, 'GET', `/api/v1/${MULTI_KEY}/${id}`)).status).toBe(404)
  })

  it('a one-word object and a built-in keep their path; resourcePath splits the suffix off before it kebabs the stem', async () => {
    const doc = (await (await s.app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(doc.paths)
    expect(paths).toContain(`/api/v1/${PROJECTS_KEY}`)
    expect(paths).toContain(`/api/v1/${PROJECTS_KEY}/{id}`)
    const meta = (await (await s.app.request('/meta/v1/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(meta.paths)).toContain('/meta/v1/blocked-senders')
    expect(resourcePath({ name: PROJECTS_KEY })).toBe(`/${PROJECTS_KEY}`)
    expect(resourcePath({ name: MULTI_KEY })).toBe('/session-recordings__c')
    expect(resourcePath({ name: 'blocked_senders' })).toBe('/blocked-senders')
    const made = await s.call(a, 'user', ALL, 'POST', `/api/v1/${PROJECTS_KEY}`, { name: 'x' })
    expect(made.status).toBe(201)
    expect((await s.call(a, 'user', ALL, 'GET', '/api/v1/projects--c')).status).toBe(404)
  })

  it('schema.get: the name is the snake key, the path the new one, and the scopes and event type are snake', async () => {
    const doc = (await (await s.call(a, 'user', ALL, 'GET', '/meta/v1/schema')).json()) as any
    const table = doc.tables.find((t: any) => t.name === MULTI_KEY)
    expect(table.resource).toMatchObject({
      name: MULTI_KEY,
      path: MULTI_PATH,
      read_scope: `${MULTI_KEY}:read`,
      write_scope: `${MULTI_KEY}:write`,
    })
    expect(doc.tables.find((t: any) => t.name === PROJECTS_KEY).resource.path).toBe(`/api/v1/${PROJECTS_KEY}`)
  })

  it('the created event is typed with the snake name', async () => {
    const made = await s.call(a, 'user', ALL, 'POST', MULTI_PATH, { title: 'Evented' })
    const id = ((await made.json()) as { id: string }).id
    const events = await s.eventsOf(id)
    expect(events.map((e) => e.type)).toEqual([`${MULTI_KEY}.created`])
    expect(events[0]!.resource_type).toBe(MULTI_KEY)
  })

  it('a multi-word extension field keeps its snake JSON key and list filter name', async () => {
    const made = await s.call(a, 'user', ALL, 'POST', '/api/v1/contacts', { name: 'Ada', referral_source__c: 'web' })
    expect(made.status).toBe(201)
    expect(((await made.json()) as any).referral_source__c).toBe('web')
    const list = (await (
      await s.call(a, 'user', ALL, 'GET', '/api/v1/contacts?referral_source__c=web')
    ).json()) as any
    expect(list.data.map((c: any) => c.name)).toEqual(['Ada'])
    const doc = JSON.stringify(((await (await s.app.request('/api/v1/openapi.json')).json()) as any).paths['/api/v1/contacts'])
    expect(doc).toContain('referral_source__c')
    expect(doc).not.toContain('referral-source')
  })

  it('the operations are named <snake key>__c.<action>', () => {
    for (const key of [PROJECTS_KEY, MULTI_KEY]) {
      const names = registry
        .operations()
        .map((o) => o.name)
        .filter((n) => n.startsWith(`${key}.`))
      expect(names.sort()).toEqual(
        ['aggregate', 'create', 'delete', 'get', 'list', 'property_keys', 'update'].map((x) => `${key}.${x}`).sort(),
      )
    }
  })
})

describe('MCP', () => {
  const rpc = async (method: string, params: unknown = {}) =>
    (await (await s.call(a, 'user', ALL, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params })).json()) as any
  it('the tools are <snake key>_<action> and a call works', async () => {
    const names = deriveTools(registry).map((t) => t.tool.name)
    for (const key of [PROJECTS_KEY, MULTI_KEY])
      for (const action of ['list', 'get', 'create', 'update', 'delete']) expect(names).toContain(`${key}_${action}`)
    expect(names.filter((n) => n.includes('session-') || n.includes('--c'))).toEqual([])
    const listed = (await rpc('tools/list')).result.tools.map((t: any) => t.name)
    expect(listed).toContain(`${MULTI_KEY}_create`)
    const made = await rpc('tools/call', { name: `${MULTI_KEY}_create`, arguments: { title: 'By tool' } })
    expect(made.result.isError, JSON.stringify(made)).not.toBe(true)
    const got = await rpc('tools/call', { name: `${MULTI_KEY}_list`, arguments: {} })
    expect(JSON.stringify(got)).toContain('By tool')
    const one = await rpc('tools/call', { name: `${PROJECTS_KEY}_create`, arguments: { name: 'By tool' } })
    expect(one.result.isError, JSON.stringify(one)).not.toBe(true)
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
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.filter((f) => /__c\b/.test(readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf-8')))
    expect(offenders).toEqual([])
  })
})
