import { describe, expect, it } from 'vitest'
import type { ScopePolicy } from '../auth/roles.js'
import { ApiError } from '../errors.js'
import { agentRecord, normalizeAgentScopes } from './agents.js'

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

describe('the agents read record (CORE77 D23)', () => {
  it('carries the four principal fields, nullable, under the column names', () => {
    expect(Object.keys(agentRecord.shape)).toEqual(expect.arrayContaining(['auth_provider', 'auth_subject', 'auth_client_id', 'delegated_by']))
    const base = { id: '0190b2c4-0000-7000-8000-000000000001', organization_id: '0190b2c4-0000-7000-8000-000000000002', name: 'a', scopes: [], disabled_at: null, created_by: '0190b2c4-0000-7000-8000-000000000003', created_at: 't', updated_at: 't' }
    expect(agentRecord.parse({ ...base, auth_provider: null, auth_subject: null, auth_client_id: null, delegated_by: null })).toMatchObject({ auth_provider: null, delegated_by: null })
    expect(() => agentRecord.parse(base)).toThrow()
  })
})
