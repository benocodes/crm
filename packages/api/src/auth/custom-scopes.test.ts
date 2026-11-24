import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { normalizeAgentScopes } from '../resources/agents.js'
import { projectsDefinition } from '../test/custom-objects.js'
import {
  SCOPE_POLICY,
  assertAgentGrantable,
  defaultGrantScopes,
  grantableScopes,
  isAgentGrantable,
  scopesForRole,
} from './roles.js'

// [[CORE315]] D24: a custom object's scopes `<key>__c:read|write|request_approval` are classified by RULE, not by SCOPE_POLICY rows: members hold them, they are agent-grantable and in the default grant, and a stored
// agent grant does not gain them. The rule applies to a declared scope only.
const declared = createVibaseRegistry({ definitions: [projectsDefinition()] }).declaredScopes()
const MINE = ['projects__c:read', 'projects__c:request_approval', 'projects__c:write']

describe('the rule', () => {
  it("has no SCOPE_POLICY rows: the policy table stays the vault's own", () => {
    expect(Object.keys(SCOPE_POLICY).filter((k) => k.includes('__c'))).toEqual([])
  })
  it('a member holds all three, an owner holds them too', () => {
    const member = scopesForRole('member', declared).toStrings()
    for (const s of MINE) expect(member).toContain(s)
    const owner = scopesForRole('owner', declared).toStrings()
    for (const s of MINE) expect(owner).toContain(s)
  })
  it('an agent may be granted each of them', () => {
    for (const s of MINE) expect(isAgentGrantable(s)).toBe(true)
    for (const s of MINE) expect(grantableScopes(declared)).toContain(s)
    expect(() => assertAgentGrantable(MINE, declared)).not.toThrow()
    expect(normalizeAgentScopes(['projects__c:write', 'projects__c:read'], SCOPE_POLICY, declared)).toEqual([
      'projects__c:read',
      'projects__c:write',
    ])
  })
  it("a newly registered client's default grant contains them", () => {
    for (const s of MINE) expect(defaultGrantScopes(declared)).toContain(s)
  })
  it('a grant stored before the object existed has none of them: the rule adds nothing to a list', () => {
    const stored = ['contacts:read', 'tasks:write']
    expect(normalizeAgentScopes(stored, SCOPE_POLICY, declared)).toEqual(['contacts:read', 'tasks:write'])
    expect(stored.filter((s) => MINE.includes(s))).toEqual([])
  })
})

describe('an undeclared __c scope is still refused', () => {
  it('is no role scope, not grantable, not in a default grant', () => {
    expect(scopesForRole('member', declared).toStrings()).not.toContain('x__c:write')
    expect(grantableScopes(declared)).not.toContain('x__c:write')
    expect(defaultGrantScopes(declared)).not.toContain('x__c:write')
  })
  it('an agent grant of it is refused unknown_scope, with or without the declared list; a malformed name too', () => {
    const code = (f: () => unknown) => {
      try {
        f()
        return undefined
      } catch (err) {
        return (err as { code?: string }).code
      }
    }
    expect(code(() => normalizeAgentScopes(['x__c:write'], SCOPE_POLICY, declared))).toBe('unknown_scope')
    expect(code(() => normalizeAgentScopes(['projects__c:write']))).toBe('unknown_scope')
    expect(code(() => normalizeAgentScopes(['projects__c:admin'], SCOPE_POLICY, declared))).toBe('unknown_scope')
    expect(code(() => normalizeAgentScopes(['projects:write'], SCOPE_POLICY, declared))).toBe('unknown_scope')
  })
})
