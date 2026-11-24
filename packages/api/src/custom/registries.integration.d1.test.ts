import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLUMN_KINDS } from '@vibase/storage'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { deriveTools } from '../mcp/tools.js'
import { fakeUserAuthenticator } from '../test/user-auth.js'
import { coldStorage } from '../test/storage.js'
import { d1Backend } from '../test/d1-backend.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '../test/custom-objects.js'
import { createTableStatements } from './ddl.js'
import { defineCustomObject } from './resource.js'

// [[CORE315]] D23: definitions reach every registry at start, with no module-level state: two registries in one process with different declarations each serve only their own, and a registry built with none is
// the registry of today (P3).
const TICKETS = { fields: { subject: { kind: 'text', required: true }, priority: { kind: 'integer' } } } as const

describe('P3: no declarations, no change', () => {
  const snapshot = async (registry: ReturnType<typeof createVibaseRegistry>) => {
    const app = createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() })
    return JSON.stringify({
      docs: [
        await (await app.request('/api/v1/openapi.json')).json(),
        await (await app.request('/meta/v1/openapi.json')).json(),
      ],
      tools: deriveTools(registry).map((e) => e.tool),
      scopes: registry.declaredScopes(),
      ops: registry.operations().map((o) => [o.name, o.method, o.path]),
      events: [...registry.eventTypes()],
    })
  }
  it('a registry with no definitions, or an empty list, has the same documents, tools, scopes and events', async () => {
    const plain = await snapshot(createVibaseRegistry())
    expect(await snapshot(createVibaseRegistry({ definitions: [] }))).toBe(plain)
    expect(await snapshot(createVibaseRegistry({}))).toBe(plain)
    expect(plain).not.toContain('__c')
  })
  it('a registry with a definition differs by exactly that object: five operations and three scopes', () => {
    const plain = createVibaseRegistry()
    const custom = createVibaseRegistry({ definitions: [projectsDefinition()] })
    const added = custom.operations().filter((o) => !plain.get(o.name))
    expect(added.map((o) => o.name).sort()).toEqual(
      ['create', 'delete', 'get', 'list', 'update'].map((x) => `${PROJECTS_KEY}.${x}`).sort(),
    )
    const scopes = custom.declaredScopes().filter((x) => !plain.declaredScopes().includes(x))
    expect(scopes).toEqual([`${PROJECTS_KEY}:read`, `${PROJECTS_KEY}:request_approval`, `${PROJECTS_KEY}:write`])
  })
})

describe('no module-level state', () => {
  it('building registries leaves the storage layer\'s column inventory as it was', () => {
    const before = JSON.stringify(COLUMN_KINDS)
    createVibaseRegistry({ definitions: [projectsDefinition(), defineCustomObject('tickets__c', TICKETS as never)] })
    expect(JSON.stringify(COLUMN_KINDS)).toBe(before)
    expect(Object.keys(COLUMN_KINDS).filter((t) => t.endsWith('__c'))).toEqual([])
  })
  it('a definition carries its own column kinds', () => {
    const def = projectsDefinition() as unknown as { columnKinds: Record<string, string> }
    expect(def.columnKinds).toMatchObject({
      id: 'uuid',
      organization_id: 'uuid',
      created_by: 'uuid',
      created_at: 'timestamp',
      updated_at: 'timestamp',
      deleted_at: 'timestamp',
      name: 'text',
      budget: 'integer',
      active: 'boolean',
      start_date: 'timestamp',
      stage: 'text',
    })
  })
})

describe('two registries in one process serve only their own', () => {
  const projects = createVibaseRegistry({ definitions: [projectsDefinition()] })
  const tickets = createVibaseRegistry({ definitions: [defineCustomObject('tickets__c', TICKETS as never)] })
  let one: ContractSession
  let two: ContractSession
  let a1: ContractTenant
  let a2: ContractTenant
  beforeAll(async () => {
    one = await d1Backend({ setup: (d1) => createCustomTables(d1) }).open(projects)
    two = await d1Backend({
      setup: async (d1) => {
        await d1.batch(createTableStatements('tickets__c', TICKETS as never).map((q) => d1.prepare(q)))
      },
    }).open(tickets)
    ;({ a: a1 } = await one.reset())
    ;({ a: a2 } = await two.reset())
  })
  afterAll(async () => {
    await one.close()
    await two.close()
  })

  it('each serves its own object, with its own fields, and 404s the other', async () => {
    const p = await one.call(a1, 'user', projects.declaredScopes(), 'POST', '/api/v1/projects__c', { name: 'P' })
    expect(p.status).toBe(201)
    const t = await two.call(a2, 'user', tickets.declaredScopes(), 'POST', '/api/v1/tickets__c', { subject: 'S', priority: 2 })
    expect(t.status).toBe(201)
    expect(await t.json()).toMatchObject({ subject: 'S', priority: 2 })
    expect((await one.call(a1, 'user', projects.declaredScopes(), 'GET', '/api/v1/tickets__c')).status).toBe(404)
    expect((await two.call(a2, 'user', tickets.declaredScopes(), 'GET', '/api/v1/projects__c')).status).toBe(404)
    // the field of the other registry's object is not a field here
    expect((await one.call(a1, 'user', projects.declaredScopes(), 'POST', '/api/v1/projects__c', { name: 'P', subject: 's' })).status).toBe(400)
  })
  it('each registry lists only its own scopes', () => {
    expect(projects.declaredScopes().some((x) => x.startsWith('tickets__c:'))).toBe(false)
    expect(tickets.declaredScopes().some((x) => x.startsWith('projects__c:'))).toBe(false)
  })
})
