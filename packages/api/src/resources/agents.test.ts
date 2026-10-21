import { describe, expect, it } from 'vitest'
import type { ScopePolicy } from '../auth/roles.js'
import { ApiError } from '../errors.js'
import { normalizeAgentScopes } from './agents.js'

const policy: ScopePolicy = {
  'a:read': { member: true, agentGrantable: true },
  'a:write': { member: true, agentGrantable: true },
  'h:read': { member: true, agentGrantable: false },
}

function fail(fn: () => unknown): { status: number; code: string; message: string } {
  try {
    fn()
  } catch (e) {
    const a = e as ApiError
    if (!(a instanceof ApiError)) throw e
    return { status: a.status, code: a.code, message: a.message }
  }
  throw new Error('did not throw')
}

describe('normalizeAgentScopes', () => {
  it('dedupes and sorts', () => {
    expect(normalizeAgentScopes(['a:write', 'a:read', 'a:write'], policy)).toEqual(['a:read', 'a:write'])
  })
  it('accepts empty', () => {
    expect(normalizeAgentScopes([], policy)).toEqual([])
  })
  it('rejects unknown scopes', () => {
    expect(fail(() => normalizeAgentScopes(['a:read', 'zz:read'], policy))).toEqual({
      status: 400,
      code: 'unknown_scope',
      message: 'unknown scope: zz:read',
    })
  })
  it.each([['A:READ'], ['a:delete']])('treats malformed %s as unknown', (s) => {
    expect(fail(() => normalizeAgentScopes([s!], policy)).code).toBe('unknown_scope')
  })
  it('refuses human-only scopes', () => {
    expect(fail(() => normalizeAgentScopes(['h:read'], policy))).toEqual({
      status: 400,
      code: 'scope_not_grantable',
      message: 'scope not grantable to an agent: h:read',
    })
  })
  it('the first offender decides', () => {
    expect(fail(() => normalizeAgentScopes(['h:read', 'zz:read'], policy)).code).toBe('scope_not_grantable')
  })
  it.each(['members:read', 'agents:read', 'agents:write'])('the real policy refuses %s', (s) => {
    expect(fail(() => normalizeAgentScopes([s])).code).toBe('scope_not_grantable')
  })
})
