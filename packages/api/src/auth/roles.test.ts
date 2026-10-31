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
  it('administration rows', () => {
    expect(SCOPE_POLICY['members:read']).toEqual({ member: true, agentGrantable: false })
    expect(SCOPE_POLICY).not.toHaveProperty('members:write')
    expect(SCOPE_POLICY['agents:read']).toEqual({ member: true, agentGrantable: false })
    expect(SCOPE_POLICY['agents:write']).toEqual({ member: false, agentGrantable: false })
  })
  it('notes rows (CORE74 D8): member and agent-grantable, read and write', () => {
    for (const scope of ['notes:read', 'notes:write']) {
      expect(SCOPE_POLICY[scope], scope).toEqual({ member: true, agentGrantable: true })
      expect(isAgentGrantable(scope)).toBe(true)
      expect(createVaultRegistry().declaredScopes()).toContain(scope)
    }
  })

  it('associations rows (CORE62 D11): member and agent-grantable, read and write', () => {
    for (const scope of ['associations:read', 'associations:write']) {
      expect(SCOPE_POLICY[scope], scope).toEqual({ member: true, agentGrantable: true })
      expect(isAgentGrantable(scope)).toBe(true)
      expect(createVaultRegistry().declaredScopes()).toContain(scope)
    }
    expect(scopesForRole('member', createVaultRegistry().declaredScopes()).toStrings()).toEqual(expect.arrayContaining(['associations:read', 'associations:write']))
  })
  it('member holds the read scopes of administration', () => {
    const member = scopesForRole('member', createVaultRegistry().declaredScopes()).toStrings()
    expect(member).toEqual(expect.arrayContaining(['members:read', 'agents:read']))
    expect(member).not.toContain('agents:write')
  })
})
