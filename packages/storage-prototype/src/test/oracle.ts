import { expect } from 'vitest'
import { uuidPattern } from './contracts.js'
/** Preserve a bijection: collapsing every id to one token would hide broken relationships. */
export function canonicalizer(organizationId: string, actorId: string) {
  const ids = new Map([
    [organizationId, 'organization'],
    [actorId, 'actor'],
  ])
  const visit = (x: any, key = ''): any => {
    if (Array.isArray(x)) return x.map((v) => visit(v, key))
    if (x && typeof x === 'object')
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, visit(v, k)]))
    if (x === null) return null
    if (/_at$/.test(key)) {
      expect(typeof x).toBe('string')
      expect(new Date(x).toISOString()).toBe(x)
      return 'TIME'
    }
    if (key === 'id' || key.endsWith('_id') || key === 'created_by') {
      expect(x).toMatch(uuidPattern)
      if (!ids.has(x)) ids.set(x, `generated-${ids.size - 2}`)
      return ids.get(x)
    }
    return x
  }
  return visit
}
