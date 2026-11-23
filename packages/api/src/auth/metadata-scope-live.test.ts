import { describe, expect, it } from 'vitest'
import { SCOPE_AREAS, areaOfScope } from './scope-areas.js'
import {
  SCOPE_DESCRIPTIONS,
  SCOPE_POLICY,
  assertAgentGrantable,
  defaultGrantScopes,
  grantableScopes,
  scopesForRole,
} from './roles.js'
import { createVibaseRegistry } from '../operations.js'
import { ScopeSet } from '../scopes.js'

// [[API516]] group 1 (D1, D4) and the registry half of group 3 (D11, P2): `messages:read_metadata` is declared, catalogued and grantable, and the registry derives an event type's
// action from its definition's read action. Replaces the dormancy pin of API514 cycle 1 (storage/content-dormancy.test.ts, deleted).
const META = 'messages:read_metadata'
const registry = createVibaseRegistry()
const declared = registry.declaredScopes()

describe('the scope is live and grantable (D1, D4)', () => {
  it('it is in the declared set beside messages:read', () => {
    expect(declared).toContain(META)
    expect(declared).toContain('messages:read')
  })
  it('it has a description, a policy row and a consent area', () => {
    expect(SCOPE_DESCRIPTIONS[META]).toMatch(/subject/i)
    expect(SCOPE_POLICY[META]).toEqual({ member: true, agentGrantable: true })
    expect(areaOfScope(META)).toBe('messages')
    expect(SCOPE_AREAS.find((a) => a.key === 'messages')?.resources).toContain('messages')
  })
  it('it is grantable to an agent and in the default agent grant', () => {
    expect(() => assertAgentGrantable([META], declared)).not.toThrow()
    expect(grantableScopes(declared)).toContain(META)
    expect(defaultGrantScopes(declared)).toContain(META)
  })
  it('every role that holds messages:read holds it (owner, member)', () => {
    for (const role of ['owner', 'member'] as const) {
      const set = scopesForRole(role, declared)
      expect(set.has({ resource: 'messages', action: 'read' })).toBe(true)
      expect(set.has({ resource: 'messages', action: 'read_metadata' })).toBe(true)
    }
  })
  it('a stored messages:read closes to the metadata scope; the metadata scope alone does not give messages:read', () => {
    expect(ScopeSet.closed(['messages:read'], declared).toStrings()).toEqual(['messages:read', META])
    expect(ScopeSet.closed([META], declared).toStrings()).toEqual([META])
  })
})

describe('messages and threads read at the metadata scope (D7)', () => {
  it('the lowered reads require it; the content operation and send keep messages:read (D8)', () => {
    for (const name of ['messages.list', 'messages.get', 'threads.list', 'threads.get']) {
      const op = registry.get(name)
      expect(op?.kind === 'tenant' ? op.scope : undefined, name).toEqual({ resource: 'messages', action: 'read_metadata' })
    }
    for (const name of ['messages.content']) {
      const op = registry.get(name)
      expect(op?.kind === 'tenant' ? op.scope : undefined, name).toEqual({ resource: 'messages', action: 'read' })
    }
  })
})

describe('Registry.eventTypes derives the action from the definition (P2)', () => {
  it('message and thread events are read at the metadata scope; an event type of no prepared definition keeps read', () => {
    const types = registry.eventTypes()
    expect(types.get('message')).toEqual({ scope: 'messages', action: 'read_metadata' })
    expect(types.get('thread')).toEqual({ scope: 'messages', action: 'read_metadata' })
    expect(types.get('task')).toEqual({ scope: 'tasks', action: 'read' })
  })
})
