import { describe, expect, it } from 'vitest'
import { ScopeSet, formatScope, parseScope } from './scopes.js'

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
