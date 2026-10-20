import { describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import { SCOPE_POLICY, assertAgentGrantable, grantableScopes, isAgentGrantable, scopesForRole, type ScopePolicy } from './roles.js'

const declared = ['a:read', 'a:write', 'b:read']
const policy: ScopePolicy = {
  'a:read': { member: true, agentGrantable: true },
  'a:write': { member: true, agentGrantable: false },
  'b:read': { member: false, agentGrantable: true },
}

describe('roles', () => {
  it('owner gets every declared scope', () => {
    expect(scopesForRole('owner', declared, policy).toStrings()).toEqual(declared)
  })
  it('member gets member-flagged scopes', () => {
    expect(scopesForRole('member', declared, policy).toStrings()).toEqual(['a:read', 'a:write'])
  })
  it('member is fail-closed for a scope with no entry', () => {
    expect(scopesForRole('member', [...declared, 'c:read'], policy).toStrings()).not.toContain('c:read')
  })
  it('grantable excludes human-only scopes, sorted', () => {
    expect(grantableScopes(['b:read', 'a:write', 'a:read'], policy)).toEqual(['a:read', 'b:read'])
  })
  it('unknown is not grantable', () => {
    expect(isAgentGrantable('zzz:read', policy)).toBe(false)
  })
  it('assertAgentGrantable', () => {
    expect(() => assertAgentGrantable(['a:read'], declared, policy)).not.toThrow()
    expect(() => assertAgentGrantable(['a:read', 'a:write'], declared, policy)).toThrow('scope not grantable to an agent: a:write')
  })
  it('catalog: policy keys equal declared scopes (P7)', () => {
    expect(Object.keys(SCOPE_POLICY).sort()).toEqual(createVaultRegistry().declaredScopes())
  })
  it('catalog: owner holds every declared scope', () => {
    const declaredReal = createVaultRegistry().declaredScopes()
    expect(scopesForRole('owner', declaredReal).toStrings()).toEqual(declaredReal)
  })
})
