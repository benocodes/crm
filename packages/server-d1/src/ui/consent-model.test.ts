import { describe, expect, it } from 'vitest'
import { buildConsentModel, defaultState, effectiveOn, grantedScopes } from './consent-model.js'

// [[UI455]] group 1 (the matrix): request shape x areas, switches, defaults and the body with the defaults untouched ([[UI449]] D3 to D6).
const DEFAULT_SET = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'contacts:read',
  'contacts:request_approval',
  'contacts:write',
  'companies:read',
  'companies:write',
  'interactions:read',
  'messages:read',
  'messages:write',
  'events:read',
  'webhooks:read',
  'webhooks:write',
]
const shape = (requested: string[]) => {
  const m = buildConsentModel(requested)
  const s = defaultState(m)
  return {
    m,
    s,
    areas: m.areas.map((a) => a.key),
    switches: (key: string) =>
      m.areas.find((a) => a.key === key)!.switches.map((w) => [w.kind, effectiveOn(m, s, w)] as const),
    body: grantedScopes(m, s),
  }
}

describe('buildConsentModel', () => {
  it('the scope-less default set: the sign-in line, four areas in catalogue order, no Administration, every write off', () => {
    const r = shape(DEFAULT_SET)
    expect(r.m.signIn).toEqual(['openid', 'profile', 'email', 'offline_access'])
    expect(r.areas).toEqual(['crm', 'messages', 'activity', 'integrations'])
    expect(r.switches('crm')).toEqual([
      ['read', true],
      ['request_approval', true],
      ['write', false],
    ])
    expect(r.switches('messages')).toEqual([
      ['read', true],
      ['request_approval', true],
      ['write', false],
    ])
    expect(r.switches('activity')).toEqual([['read', true]])
    expect(r.body).toBe(
      'openid profile email offline_access contacts:read contacts:request_approval companies:read interactions:read messages:read events:read webhooks:read',
    )
  })

  it('a narrow named request: one area, one Read switch, on', () => {
    const r = shape(['openid', 'contacts:read'])
    expect(r.areas).toEqual(['crm'])
    expect(r.switches('crm')).toEqual([['read', true]])
    expect(r.body).toBe('openid contacts:read')
  })

  it('audit:read alone: Administration shown, its Read off (NOT_DEFAULT_GRANT)', () => {
    const r = shape(['openid', 'audit:read'])
    expect(r.areas).toEqual(['admin'])
    expect(r.switches('admin')).toEqual([['read', false]])
    expect(r.body).toBe('openid')
  })

  it('audit:read beside a default-on read of its area: a separate sensitive switch, off, while the area Read is on', () => {
    const r = shape(['members:read', 'audit:read'])
    expect(r.switches('admin')).toEqual([
      ['read', true],
      ['read_sensitive', false],
    ])
    expect(r.body).toBe('members:read')
  })

  it('one area with only *:write requested: only a Write switch, off, and no Propose switch', () => {
    const r = shape(['openid', 'contacts:write'])
    expect(r.switches('crm')).toEqual([['write', false]])
    expect(r.body).toBe('openid')
  })

  it('a sign-in-only request: the line, no areas, a body of the line', () => {
    const r = shape(['openid', 'offline_access'])
    expect(r.m.signIn).toEqual(['openid', 'offline_access'])
    expect(r.areas).toEqual([])
    expect(r.body).toBe('openid offline_access')
  })

  it('an unknown-but-parseable name sits under Other with the D4 defaults; an unparseable name is off, by name', () => {
    const r = shape(['foo:read', 'foo:write', 'Bad Name<b>'])
    expect(r.areas).toEqual(['other'])
    const other = r.m.areas[0]!
    expect(other.name).toBe('Other')
    expect(other.requested).toEqual(['foo:read', 'foo:write', 'Bad Name<b>'])
    expect(r.switches('other')).toEqual([
      ['read', true],
      ['write', false],
      ['name', false],
    ])
    expect(other.switches.at(-1)!.label).toBe('Bad Name<b>')
    expect(r.body).toBe('foo:read')
  })

  it('the body keeps request order, not catalogue order, and drops repeats', () => {
    const r = shape(['messages:read', 'contacts:read', 'openid', 'contacts:read', 'companies:read'])
    expect(r.body).toBe('messages:read contacts:read openid companies:read')
  })

  it('the areas list only the requested scopes of each, in request order', () => {
    const r = shape(['companies:read', 'messages:read', 'contacts:read'])
    expect(r.m.areas.find((a) => a.key === 'crm')!.requested).toEqual(['companies:read', 'contacts:read'])
  })
})

describe('Write forces Propose', () => {
  it('Write on makes the effective Propose on and puts the area write and request_approval scopes in the body; off releases it to what it was', () => {
    const m = buildConsentModel(['contacts:read', 'contacts:request_approval', 'contacts:write'])
    const id = (k: string) => m.areas[0]!.switches.find((w) => w.kind === k)!
    const s = { ...defaultState(m), [id('request_approval').id]: false }
    expect(grantedScopes(m, s)).toBe('contacts:read')
    const on = { ...s, [id('write').id]: true }
    expect(effectiveOn(m, on, id('request_approval'))).toBe(true)
    expect(grantedScopes(m, on)).toBe('contacts:read contacts:request_approval contacts:write')
    const off = { ...on, [id('write').id]: false }
    expect(effectiveOn(m, off, id('request_approval'))).toBe(false)
    expect(grantedScopes(m, off)).toBe('contacts:read')
  })
})
