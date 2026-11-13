import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettingsPath, loadSettings, parseSettings } from './settings.js'
import { PLACEHOLDER_DATABASE_ID, CONTROL_PLACEHOLDER_DATABASE_ID } from '../remote.js'
import { CONTROL_D1, cleanup, controlSettings, mkTmp, UUID, validSettings } from './test-kit.js'
import { InstanceRefusal } from './types.js'

afterEach(cleanup)
const parse = (o: Record<string, unknown>, env = 'demo') => parseSettings(JSON.stringify(o), env, '/s/demo.json')
const refuses = (o: Record<string, unknown> | string, re: RegExp, env = 'demo') => {
  const text = typeof o === 'string' ? o : JSON.stringify(o)
  expect(() => parseSettings(text, env, '/s/demo.json')).toThrow(InstanceRefusal)
  expect(() => parseSettings(text, env, '/s/demo.json')).toThrow(re)
}

describe('D9 default path', () => {
  it('is $XDG_CONFIG_HOME/vibase/instances/<env>.json', () => {
    expect(defaultSettingsPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u', 'demo')).toBe('/x/cfg/vibase/instances/demo.json')
  })
  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or empty', () => {
    expect(defaultSettingsPath({}, '/home/u', 'demo')).toBe('/home/u/.config/vibase/instances/demo.json')
    expect(defaultSettingsPath({ XDG_CONFIG_HOME: '' }, '/home/u', 'demo')).toBe('/home/u/.config/vibase/instances/demo.json')
  })
})

describe('D9 settings validation', () => {
  it('a valid file parses to the documented shape', () => {
    const s = parse(validSettings({ crons: ['* * * * *'] }))
    expect(s).toEqual({ ...validSettings(), crons: ['* * * * *'] })
  })
  it('a missing file names its path', () => {
    const p = join(mkTmp(), 'nope', 'demo.json')
    expect(() => loadSettings(p, 'demo')).toThrow(InstanceRefusal)
    expect(() => loadSettings(p, 'demo')).toThrow(p)
  })
  it('loadSettings reads a file from disk', () => {
    const d = mkTmp()
    mkdirSync(join(d, 'a'))
    const p = join(d, 'a', 'x.json')
    writeFileSync(p, JSON.stringify(validSettings()))
    expect(loadSettings(p, 'demo').worker).toBe('vault-demo')
  })
  it('refuses text that is not JSON, naming the path', () => refuses('{nope', /\/s\/demo\.json.*JSON/))
  it('refuses an unknown top-level key by name', () => refuses(validSettings({ extra: 1 }), /unknown key "extra"/))
  it('refuses an unknown key inside d1 by name', () => refuses(validSettings({ d1: { name: 'a', id: UUID, extra: 1 } }), /d1\.extra/))
  it('refuses a version that is not 1', () => {
    refuses(validSettings({ version: 2 }), /version must be 1/)
    refuses({ ...validSettings(), version: undefined }, /version must be 1/)
  })
  it('refuses an env that differs from --env', () => refuses(validSettings({ env: 'other' }), /env "other" does not match --env demo/))
  it.each(['https://api.demo.invalid', 'api.demo.invalid/path', 'api.demo.invalid:8787', '', 'api demo'])('refuses api_host %j (a bare host only)', (h) => refuses(validSettings({ api_host: h }), /api_host/))
  it('refuses a d1.id that is not a UUID', () => refuses(validSettings({ d1: { name: 'a', id: 'nope' } }), /d1\.id/))
  it('refuses the local placeholder d1.id', () => refuses(validSettings({ d1: { name: 'a', id: '00000000-0000-0000-0000-000000000000' } }), /d1\.id.*placeholder/))
  it.each(['worker', 'r2_bucket'])('refuses a missing %s', (k) => refuses({ ...validSettings(), [k]: undefined }, new RegExp(k)))
  it('refuses workflow without a name and vars that are not strings', () => {
    refuses(validSettings({ workflow: {} }), /workflow\.name/)
    refuses(validSettings({ vars: { A: 1 } }), /vars\.A/)
  })
  it('refuses crons that are not a list of strings', () => refuses(validSettings({ crons: 'x' }), /crons/))
  it('holds no version of the deployed release: a "release" or "deployed_version" key is an unknown key', () => refuses(validSettings({ deployed_version: '0.1.0' }), /deployed_version/))
})

describe('OPS275 control_d1 (P1, P2, D16)', () => {
  it('absent loads (P1), with AUTH_PROVIDER unset or clerk', () => {
    expect(parse(validSettings()).control_d1).toBeUndefined()
    expect(parse(validSettings({ vars: { AUTH_PROVIDER: 'clerk' } })).control_d1).toBeUndefined()
    expect(parse(validSettings({ vars: {} })).control_d1).toBeUndefined()
  })
  it('present loads and round-trips through the settings writer\'s JSON text', () => {
    const s = parse(controlSettings())
    expect(s.control_d1).toEqual(CONTROL_D1)
    expect(parse(JSON.parse(JSON.stringify(s, null, 2)))).toEqual(s)
  })
  it('present with better-auth loads', () => {
    expect(parse(controlSettings({ vars: { AUTH_PROVIDER: 'better-auth' } })).control_d1).toEqual(CONTROL_D1)
  })
  it('refuses, naming the key: an unknown nested key, a non-UUID id, either placeholder, the CRM id, the CRM name, a non-object', () => {
    refuses(controlSettings({ control_d1: { ...CONTROL_D1, extra: 1 } }), /control_d1\.extra/)
    refuses(controlSettings({ control_d1: { ...CONTROL_D1, id: 'nope' } }), /control_d1\.id.*UUID/)
    refuses(controlSettings({ control_d1: { ...CONTROL_D1, id: PLACEHOLDER_DATABASE_ID } }), /control_d1\.id.*placeholder/)
    refuses(controlSettings({ control_d1: { ...CONTROL_D1, id: CONTROL_PLACEHOLDER_DATABASE_ID } }), /control_d1\.id.*placeholder/)
    refuses(controlSettings({ control_d1: { ...CONTROL_D1, id: UUID } }), /control_d1\.id.*d1\.id/)
    refuses(controlSettings({ control_d1: { ...CONTROL_D1, name: 'vault-demo' } }), /control_d1\.name.*d1\.name/)
    refuses(controlSettings({ control_d1: { id: CONTROL_D1.id } }), /control_d1\.name/)
    refuses(controlSettings({ control_d1: 'x' }), /control_d1 must be an object/)
  })
  it('P2: AUTH_PROVIDER=better-auth without control_d1 is refused', () => {
    refuses(validSettings({ vars: { AUTH_PROVIDER: 'better-auth' } }), /control_d1.*better-auth/)
  })
})
