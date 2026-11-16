import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from './operations.js'
import { administrationScenarios } from './test/golden/scenarios.js'
import * as scenarios from './test/golden/scenarios.js'

// CORE357 groups 3 and 4 (P1, P3): the event-type map holds no retired type, and the texts that mention key changes say the audit log, not the feed.
const registry = createVibaseRegistry()

describe('the event-type map holds no retired type', () => {
  it('has no api_key and no webhook entry', () => {
    const types = [...registry.eventTypes().keys()]
    expect(types).not.toContain('api_key')
    expect(types).not.toContain('webhook')
  })
})

describe('texts state what the code defines', () => {
  const ops = registry.operations()
  const texts: [string, string][] = [
    ...ops.map((o) => [`operation ${o.name}`, `${o.summary}\n${o.description ?? ''}`] as [string, string]),
    ...Object.values(scenarios)
      .filter(Array.isArray)
      .flat()
      .map((s: any) => [`scenario ${s.name}`, String(s.about ?? '')] as [string, string]),
  ]
  it('no text names api_key.* as an event or says a key change emits one', () => {
    expect(administrationScenarios.length).toBeGreaterThan(0)
    const bad = texts.filter(([, t]) => /api_key\.(\*|created|revoked)/.test(t) || /emits? api_key/.test(t))
    expect(bad.map(([n]) => n)).toEqual([])
  })
  it('a text about key changes and the audit log names audit.list and audit:read, which exist', () => {
    const names = new Set(ops.map((o) => o.name))
    expect(names.has('audit.list')).toBe(true)
    expect(registry.declaredScopes()).toContain('audit:read')
    const keyOps = texts.filter(([n]) => n === 'operation api_keys.create' || n === 'operation api_keys.revoke')
    expect(keyOps).toHaveLength(2)
    for (const [n, t] of keyOps) {
      expect(t, n).toMatch(/audit\.list/)
      expect(t, n).toMatch(/audit:read/)
    }
    const scen = texts.find(([n]) => n === 'scenario api-keys-issue-revoke')!
    expect(scen[1]).toMatch(/audit log/)
  })
})
