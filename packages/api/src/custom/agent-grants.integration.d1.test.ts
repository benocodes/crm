import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { createVibaseRegistry } from '../operations.js'
import { d1Backend } from '../test/d1-backend.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { PROJECTS_KEY, createCustomTables, projectsDefinition } from '../test/custom-objects.js'

// [[CORE315]] D24: an owner grants a custom object's scopes through agents.create and agents.update (REST), and an undeclared __c scope is refused unknown_scope.
const registry = createVibaseRegistry({ definitions: [projectsDefinition()] })
const ALL = registry.declaredScopes()
const d1s: D1Like[] = []
let s: ContractSession
let a: ContractTenant
beforeAll(async () => {
  s = await d1Backend({
    setup: async (d1) => {
      d1s.push(d1)
      await createCustomTables(d1)
    },
  }).open(registry)
})
afterAll(() => s.close())
beforeEach(async () => {
  ;({ a } = await s.reset())
})
const call = async (method: string, path: string, body?: unknown) => {
  const r = await s.call(a, 'user', ALL, method, path, body)
  return { status: r.status, body: (await r.json().catch(() => null)) as any }
}
const stored = async (id: string) =>
  JSON.parse(
    ((await d1s[0]!.prepare('SELECT scopes FROM agents WHERE id = ?').bind(id).first()) as { scopes: string }).scopes,
  )

describe('an owner grants the scopes of a custom object', () => {
  it('agents.create stores them', async () => {
    const r = await call('POST', '/meta/v1/agents', { name: 'bot', scopes: [`${PROJECTS_KEY}:write`] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(await stored(r.body.id)).toEqual([`${PROJECTS_KEY}:write`])
  })
  it('agents.update takes add_scopes and a full scopes list', async () => {
    const made = await call('POST', '/meta/v1/agents', { name: 'bot', scopes: ['tasks:read'] })
    const added = await call('PATCH', `/meta/v1/agents/${made.body.id}`, { add_scopes: [`${PROJECTS_KEY}:read`] })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect(await stored(made.body.id)).toEqual([`${PROJECTS_KEY}:read`, 'tasks:read'])
    const full = await call('PATCH', `/meta/v1/agents/${made.body.id}`, { scopes: [`${PROJECTS_KEY}:write`] })
    expect(full.status, JSON.stringify(full.body)).toBe(200)
    expect(await stored(made.body.id)).toEqual([`${PROJECTS_KEY}:write`])
  })
  it('an undeclared __c scope is refused unknown_scope on create, add_scopes and a full list', async () => {
    const created = await call('POST', '/meta/v1/agents', { name: 'bot2', scopes: ['x__c:write'] })
    expect([created.status, created.body.error.code]).toEqual([400, 'unknown_scope'])
    const made = await call('POST', '/meta/v1/agents', { name: 'bot3' })
    for (const body of [{ add_scopes: ['x__c:write'] }, { scopes: ['x__c:write'] }]) {
      const r = await call('PATCH', `/meta/v1/agents/${made.body.id}`, body)
      expect([r.status, r.body.error.code]).toEqual([400, 'unknown_scope'])
    }
  })
})

// [[CORE630]] D10: the grant check reads the scopes the registry declares, not the caller's own. A caller that holds `agents:write` and no scope of the custom object (a limited login, an agent with the narrower list)
// grants it all the same; an undeclared scope and a human-only scope stay refused.
describe('D10: the grant check reads the declared scopes, whatever the caller holds', () => {
  const NARROW = ['agents:read', 'agents:write']
  const asNarrow = async (method: string, path: string, body?: unknown) => {
    const r = await s.call(a, 'user', NARROW, method, path, body)
    return { status: r.status, body: (await r.json().catch(() => null)) as any }
  }
  it('agents.create, a full scopes list and add_scopes accept a declared custom scope the caller does not hold', async () => {
    expect(NARROW).not.toContain(`${PROJECTS_KEY}:write`)
    const created = await asNarrow('POST', '/meta/v1/agents', { name: 'bot', scopes: [`${PROJECTS_KEY}:write`] })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(await stored(created.body.id)).toEqual([`${PROJECTS_KEY}:write`])
    const full = await asNarrow('PATCH', `/meta/v1/agents/${created.body.id}`, { scopes: [`${PROJECTS_KEY}:read`] })
    expect(full.status, JSON.stringify(full.body)).toBe(200)
    const added = await asNarrow('PATCH', `/meta/v1/agents/${created.body.id}`, {
      add_scopes: [`${PROJECTS_KEY}:write`],
    })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect(await stored(created.body.id)).toEqual([`${PROJECTS_KEY}:read`, `${PROJECTS_KEY}:write`])
  })
  it('an undeclared custom scope is still 400 unknown_scope and a human-only scope is still 400 scope_not_grantable, for a caller holding every scope or few', async () => {
    const made = await asNarrow('POST', '/meta/v1/agents', { name: 'bot2' })
    for (const body of [{ add_scopes: ['x__c:write'] }, { scopes: ['x__c:write'] }]) {
      const r = await asNarrow('PATCH', `/meta/v1/agents/${made.body.id}`, body)
      expect([r.status, r.body.error.code]).toEqual([400, 'unknown_scope'])
    }
    const human = await asNarrow('PATCH', `/meta/v1/agents/${made.body.id}`, { add_scopes: ['agents:write'] })
    expect([human.status, human.body.error.code]).toEqual([400, 'scope_not_grantable'])
  })
})
