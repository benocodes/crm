import { describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { parseInput, scopeResourceOf } from './define.js'
import { companies } from './companies.js'
import { contacts } from './contacts.js'
import { identities } from './identities.js'

const uuid = '0190b2c4-0000-7000-8000-000000000001'

describe('identity definitions', () => {
  it('scope resources', () => {
    expect([companies, contacts, identities].map(scopeResourceOf)).toEqual(['companies', 'contacts', 'contacts'])
  })
  it('declared scopes', () => {
    expect(createVaultRegistry().declaredScopes()).toEqual([
      'agents:read', 'agents:write', 'associations:read', 'associations:write', 'companies:read', 'companies:write', 'contacts:read', 'contacts:write', 'files:read',
      'interactions:read', 'members:read', 'messages:read', 'notes:read', 'notes:write', 'schema:read', 'tasks:read', 'tasks:write',
    ])
  })
  it('operations registered', () => {
    const names = createVaultRegistry().operations().map((o) => o.name)
    for (const r of ['companies', 'contacts', 'identities', 'tasks']) {
      for (const a of ['list', 'get', 'create', 'update', 'delete']) expect(names).toContain(`${r}.${a}`)
    }
    expect(names).toContain('identities.resolve')
    expect(names).toContain('contacts.merge')
  })
  it('merge route', () => {
    expect(createVaultRegistry().get('contacts.merge')).toMatchObject({
      method: 'post', path: '/contacts/{id}/merge', scope: { resource: 'contacts', action: 'write' }, response: { status: 200 },
    })
  })
  it('resolve route', () => {
    expect(createVaultRegistry().get('identities.resolve')).toMatchObject({
      method: 'post', path: '/identities/resolve', scope: { resource: 'contacts', action: 'write' }, response: { status: 200 },
    })
  })
  it('identity patch is strict', () => {
    expect(() => parseInput(identities.update!, { kind: 'phone' })).toThrow()
    expect(() => parseInput(identities.update!, { value: 'x' })).toThrow()
  })
  it('merged_into_id not writable', () => {
    expect(() => parseInput(contacts.create!, { merged_into_id: uuid })).toThrow()
    expect(() => parseInput(contacts.update!, { merged_into_id: uuid })).toThrow()
  })
  it('fill fields', () => {
    expect(Object.keys(contacts.update!.shape)).toEqual(['name', 'company_id'])
  })
})
