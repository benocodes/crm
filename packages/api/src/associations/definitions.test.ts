import { describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'

// CORE62 D9, D11, D12: the associable set comes from the registry's definition flag, and the four operations are declared.
describe('associations registration', () => {
  const registry = createVaultRegistry()

  it('exactly contacts, companies, tasks, notes, threads and interactions are associable', () => {
    expect(registry.resources().filter((d) => d.associable).map((d) => d.table).sort()).toEqual(['companies', 'contacts', 'interactions', 'notes', 'tasks', 'threads'])
  })

  it('declares associations.create/get/delete/list under the associations scopes', () => {
    const scope = (n: string) => {
      const op = registry.get(n)
      return op?.kind === 'tenant' ? `${op.scope.resource}:${op.scope.action}` : undefined
    }
    expect(scope('associations.create')).toBe('associations:write')
    expect(scope('associations.delete')).toBe('associations:write')
    expect(scope('associations.get')).toBe('associations:read')
    expect(scope('associations.list')).toBe('associations:read')
    expect(registry.declaredScopes()).toEqual(expect.arrayContaining(['associations:read', 'associations:write']))
  })

  it('has no update operation (D12)', () => {
    expect(registry.get('associations.update')).toBeUndefined()
  })
})
