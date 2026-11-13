import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettingsPath, loadSettings, parseSettings } from './settings.js'
import { cleanup, mkTmp, UUID, validSettings } from './test-kit.js'
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
