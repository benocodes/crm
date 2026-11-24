// [[UI449]] D1/D2: the consent areas cover the declared scopes exactly, and the leaf stays a leaf with the one `NOT_DEFAULT_GRANT`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { parseScope } from '../scopes.js'
import { NOT_DEFAULT_GRANT as ROLES_NOT_DEFAULT_GRANT, defaultGrantScopes } from './roles.js'
import { NOT_DEFAULT_GRANT, SCOPE_AREAS, areaOfScope, type ScopeArea } from './scope-areas.js'

const declared = createVibaseRegistry().declaredScopes()
const declaredResources = new Set(declared.map((s) => parseScope(s).resource))

/** The catalogue's invariants over any area list, so the absence mutations can run them on a broken copy. */
function problems(areas: readonly ScopeArea[]): string[] {
  const out: string[] = []
  const seen = new Map<string, string>()
  for (const a of areas) {
    if (!a.name.trim() || !a.sentence.trim()) out.push(`${a.key}: empty name or sentence`)
    for (const r of a.resources) {
      if (seen.has(r)) out.push(`${r}: in ${seen.get(r)} and ${a.key}`)
      seen.set(r, a.key)
      if (!declaredResources.has(r)) out.push(`${r}: no declared scope`)
    }
  }
  for (const r of declaredResources) if (!seen.has(r)) out.push(`${r}: in no area`)
  return out
}

describe('scope areas (UI449 D1, D2)', () => {
  it('the six areas and their resources are the spec’s (custom holds no fixed resource: it is a name rule, CORE543 P6)', () => {
    expect(SCOPE_AREAS.map((a) => [a.key, [...a.resources]])).toEqual([
      ['crm', ['contacts', 'companies', 'deals', 'pipelines', 'tasks', 'notes', 'tags', 'associations']],
      ['messages', ['interactions', 'messages', 'files', 'connections', 'blocked_senders', 'forms']],
      ['activity', ['events', 'action_requests']],
      ['integrations', ['webhooks', 'schema']],
      ['admin', ['members', 'agents', 'invitations', 'audit']],
      ['custom', []],
    ])
  })

  it('covers every declared scope’s resource exactly once, with a name and a sentence each', () => {
    expect(problems(SCOPE_AREAS)).toEqual([])
    for (const s of declared) expect(areaOfScope(s), s).not.toBeNull()
  })

  it('absence mutations: a dropped, an undeclared and a doubled resource are each caught', () => {
    const drop = SCOPE_AREAS.map((a) => (a.key === 'crm' ? { ...a, resources: a.resources.slice(1) } : a))
    expect(problems(drop)).not.toEqual([])
    const add = SCOPE_AREAS.map((a) => (a.key === 'crm' ? { ...a, resources: [...a.resources, 'ghosts'] } : a))
    expect(problems(add)).not.toEqual([])
    const twice = SCOPE_AREAS.map((a) => (a.key === 'activity' ? { ...a, resources: [...a.resources, 'tasks'] } : a))
    expect(problems(twice)).not.toEqual([])
  })

  it('every <key>__c scope of a declared set that includes custom objects is in the custom area (CORE543 P6)', () => {
    const withCustom = [...declared, 'projects__c:read', 'projects__c:write', 'projects__c:request_approval']
    expect(withCustom.filter((s) => areaOfScope(s) === 'custom')).toEqual([
      'projects__c:read',
      'projects__c:write',
      'projects__c:request_approval',
    ])
    for (const s of withCustom) expect(areaOfScope(s), s).not.toBeNull()
    expect(areaOfScope('milestones__c:read_metadata')).toBe('custom')
    // The name rule needs the suffix: a plain unknown resource, or a stray double underscore, is in no area.
    expect(areaOfScope('projects_c:read')).toBeNull()
    expect(areaOfScope('projects__x:read')).toBeNull()
    const custom = SCOPE_AREAS.find((a) => a.key === 'custom')!
    expect(custom.name).toBe('Custom records')
    expect(custom.sentence.trim()).not.toBe('')
  })

  it('areaOfScope looks a scope up by its resource; a name in no area or unparseable is none', () => {
    expect(areaOfScope('contacts:read')).toBe('crm')
    expect(areaOfScope('messages:write')).toBe('messages')
    expect(areaOfScope('audit:read')).toBe('admin')
    expect(areaOfScope('webhooks:request_approval')).toBe('integrations')
    expect(areaOfScope('ghosts:read')).toBeNull()
    expect(areaOfScope('messages:read_metadata')).toBe('messages')
    expect(areaOfScope('contacts:read_metadata')).toBe('crm')
    for (const bad of ['messages:read_meta', 'messages:readmetadata', 'Messages:read_metadata'])
      expect(areaOfScope(bad), bad).toBeNull()
    expect(areaOfScope('openid')).toBeNull()
    expect(areaOfScope('')).toBeNull()
  })

  it('the leaf imports nothing', () => {
    const src = readFileSync(new URL('./scope-areas.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/^\s*(import|export)\s[^;\n]*\sfrom\s/m)
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })

  it('NOT_DEFAULT_GRANT has one source: roles re-exports the leaf’s, and the default grant is unchanged', () => {
    expect(ROLES_NOT_DEFAULT_GRANT).toBe(NOT_DEFAULT_GRANT)
    expect(NOT_DEFAULT_GRANT).toEqual(['audit:read'])
    expect(defaultGrantScopes(declared)).not.toContain('audit:read')
    const rolesSrc = readFileSync(new URL('./roles.ts', import.meta.url), 'utf8')
    expect(rolesSrc.match(/NOT_DEFAULT_GRANT\s*(:[^=]+)?=/g) ?? []).toEqual([])
  })
})
