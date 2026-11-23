import { describe, expect, it } from 'vitest'
import { ScopeSet, closeScopes, formatScope, parseScope } from './scopes.js'

describe('scopes', () => {
  it('parses', () => {
    expect(parseScope('tasks:read')).toEqual({ resource: 'tasks', action: 'read' })
  })
  it('parses underscores', () => {
    expect(parseScope('api_keys:write')).toEqual({ resource: 'api_keys', action: 'write' })
  })
  it.each(['tasks', 'tasks:delete', 'Tasks:read', ':read', 'tasks:read:x', ''])('rejects malformed %j', (s) => {
    expect(() => parseScope(s)).toThrow(`invalid scope: ${s}`)
  })
  it('formats', () => {
    expect(formatScope({ resource: 'tasks', action: 'write' })).toBe('tasks:write')
  })
  it('has', () => {
    const set = ScopeSet.parse(['tasks:read'])
    expect(set.has({ resource: 'tasks', action: 'read' })).toBe(true)
    expect(set.has({ resource: 'tasks', action: 'write' })).toBe(false)
    expect(set.has({ resource: 'contacts', action: 'read' })).toBe(false)
  })
  it('write does not imply read', () => {
    expect(ScopeSet.parse(['tasks:write']).has({ resource: 'tasks', action: 'read' })).toBe(false)
  })
  it('parse refuses malformed', () => {
    expect(() => ScopeSet.parse(['tasks:read', 'bogus'])).toThrow('invalid scope: bogus')
  })
  it('toStrings sorts and deduplicates', () => {
    expect(ScopeSet.parse(['tasks:write', 'tasks:read', 'tasks:read']).toStrings()).toEqual([
      'tasks:read',
      'tasks:write',
    ])
  })
})

// [[AGT8]] D31: the closure of a scope set under write => request_approval, and the four containment cases.
describe('closure under write => request_approval (D31)', () => {
  const meet = (...lists: string[][]) => {
    const closed = lists.map((l) => closeScopes(l))
    return [...new Set(closed.flat())].filter((s) => closed.every((l) => l.includes(s))).sort()
  }
  it('parses the third action', () => {
    expect(parseScope('tasks:request_approval')).toEqual({ resource: 'tasks', action: 'request_approval' })
  })
  it('write adds request_approval of the same resource and nothing else', () => {
    expect(closeScopes(['tasks:write']).sort()).toEqual(['tasks:request_approval', 'tasks:write'])
    expect(closeScopes(['tasks:read']).sort()).toEqual(['tasks:read'])
    expect(closeScopes(['tasks:request_approval']).sort()).toEqual(['tasks:request_approval'])
  })
  it('limits the added scopes to declared ones', () => {
    expect(
      closeScopes(['agents:write', 'tasks:write'], ['tasks:write', 'tasks:request_approval', 'agents:write']).sort(),
    ).toEqual(['agents:write', 'tasks:request_approval', 'tasks:write'])
  })
  it('case 1: a request_approval token over a write cap keeps request_approval only', () => {
    expect(meet(['tasks:request_approval'], ['tasks:write'])).toEqual(['tasks:request_approval'])
  })
  it('case 2: a write token over a request_approval cap keeps request_approval only', () => {
    expect(meet(['tasks:write'], ['tasks:request_approval'])).toEqual(['tasks:request_approval'])
  })
  it('case 3: a read token holds neither, over any cap', () => {
    expect(meet(['tasks:read'], ['tasks:write', 'tasks:read'])).toEqual(['tasks:read'])
    expect(meet(['tasks:read'], ['tasks:request_approval'])).toEqual([])
  })
  it('case 4: write without read implies nothing about read', () => {
    expect(ScopeSet.closed(['tasks:write']).has({ resource: 'tasks', action: 'read' })).toBe(false)
    expect(ScopeSet.closed(['tasks:write']).has({ resource: 'tasks', action: 'request_approval' })).toBe(true)
  })
  it("parse alone does not close: closing is the authenticators' job", () => {
    expect(ScopeSet.parse(['tasks:write']).has({ resource: 'tasks', action: 'request_approval' })).toBe(false)
  })
})

// [[API518]] D2 and D3 (P1): the action `read_metadata` is in the grammar, and `read => read_metadata` closes only where it is declared.
describe('the read_metadata action (API518 D2)', () => {
  it('parses and formats it', () => {
    expect(parseScope('messages:read_metadata')).toEqual({ resource: 'messages', action: 'read_metadata' })
    expect(formatScope({ resource: 'messages', action: 'read_metadata' })).toBe('messages:read_metadata')
  })
  it.each(['x:read_meta', 'x:readmetadata', 'X:read_metadata', 'x:read_metadata_', 'x:read-metadata', 'x:metadata'])(
    'still refuses malformed %j',
    (s) => {
      expect(() => parseScope(s)).toThrow(`invalid scope: ${s}`)
    },
  )
})

describe('closure under read => read_metadata (API518 D3, P1)', () => {
  const declared = ['x:read', 'x:read_metadata', 'y:read', 'x:write', 'x:request_approval']
  it('x:read gives x:read_metadata when it is declared', () => {
    expect(closeScopes(['x:read'], declared).sort()).toEqual(['x:read', 'x:read_metadata'])
  })
  it('adds nothing when declared is absent (the grammar has no resource list)', () => {
    expect(closeScopes(['x:read'])).toEqual(['x:read'])
    expect(ScopeSet.closed(['x:read']).has({ resource: 'x', action: 'read_metadata' })).toBe(false)
  })
  it('adds nothing for a resource that does not declare it, or with an empty declared', () => {
    expect(closeScopes(['y:read'], declared)).toEqual(['y:read'])
    expect(closeScopes(['x:read'], [])).toEqual(['x:read'])
  })
  it('read_metadata implies nothing: not read, not write, not request_approval', () => {
    expect(closeScopes(['x:read_metadata'], declared)).toEqual(['x:read_metadata'])
    const set = ScopeSet.closed(['x:read_metadata'], declared)
    for (const action of ['read', 'write', 'request_approval'] as const)
      expect(set.has({ resource: 'x', action })).toBe(false)
  })
  it('write => request_approval is unchanged beside it, and write does not give read_metadata', () => {
    expect(closeScopes(['x:write'], declared).sort()).toEqual(['x:request_approval', 'x:write'])
    expect(closeScopes(['x:write']).sort()).toEqual(['x:request_approval', 'x:write'])
  })
  it('keeps no duplicates', () => {
    expect(closeScopes(['x:read', 'x:read_metadata', 'x:read'], declared).sort()).toEqual(['x:read', 'x:read_metadata'])
  })
  it('an empty input stays empty', () => {
    expect(closeScopes([], declared)).toEqual([])
  })
  it('parse alone does not close', () => {
    expect(ScopeSet.parse(['x:read']).has({ resource: 'x', action: 'read_metadata' })).toBe(false)
  })
})
