import { describe, expect, it } from 'vitest'
import { SCOPE_DESCRIPTIONS } from '@vibase/api/scope-descriptions'
import { scopeItems } from './scope-text.js'

// [[UI247]] D5: the registry's one catalogue for vault scopes, the page's own sentences for the four OIDC scopes, "No description" for the rest; every value is text.
describe('scopeItems', () => {
  it('a vault scope shows its catalogue sentence', () => {
    expect(scopeItems(['contacts:read'])).toEqual([{ name: 'contacts:read', description: SCOPE_DESCRIPTIONS['contacts:read'] }])
    expect(SCOPE_DESCRIPTIONS['contacts:read']).toBeTruthy()
  })

  it('the four OIDC scopes have the page\'s own sentences, offline_access being "Stay signed in"', () => {
    const items = scopeItems(['openid', 'profile', 'email', 'offline_access'])
    expect(items.map((i) => i.name)).toEqual(['openid', 'profile', 'email', 'offline_access'])
    for (const i of items) expect(i.description.length, i.name).toBeGreaterThan(10)
    expect(items[3]!.description).toBe('Stay signed in: keep access until you sign out or the access is revoked')
    expect(new Set(items.map((i) => i.description)).size).toBe(4)
  })

  it('an unknown scope is shown by name with "No description"', () => {
    expect(scopeItems(['nope:read'])).toEqual([{ name: 'nope:read', description: 'No description' }])
  })

  it('keeps the order, drops empty names and repeats', () => {
    expect(scopeItems(['b:x', '', 'a:y', 'b:x']).map((i) => i.name)).toEqual(['b:x', 'a:y'])
  })

  it('every catalogue key resolves to its own sentence', () => {
    const names = Object.keys(SCOPE_DESCRIPTIONS)
    expect(scopeItems(names).map((i) => i.description)).toEqual(names.map((n) => SCOPE_DESCRIPTIONS[n]))
  })
})
