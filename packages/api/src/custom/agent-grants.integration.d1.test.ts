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
