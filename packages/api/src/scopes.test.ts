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
    expect(ScopeSet.parse(['tasks:write', 'tasks:read', 'tasks:read']).toStrings()).toEqual(['tasks:read', 'tasks:write'])
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
    expect(closeScopes(['agents:write', 'tasks:write'], ['tasks:write', 'tasks:request_approval', 'agents:write']).sort()).toEqual(['agents:write', 'tasks:request_approval', 'tasks:write'])
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
  it('parse alone does not close: closing is the authenticators\' job', () => {
    expect(ScopeSet.parse(['tasks:write']).has({ resource: 'tasks', action: 'request_approval' })).toBe(false)
  })
})
