// DX637 group 1 (P4): the build's settings, and the real build output.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../scripts/build.js'
import { resolveConfig } from './settings.js'

const dirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'browser-app-build-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('resolveConfig', () => {
  it('reads both settings from the environment', () => {
    expect(resolveConfig({ VIBASE_URL: 'http://localhost:8787', VIBASE_CLIENT_ID: 'c1' })).toEqual({
      vibaseUrl: 'http://localhost:8787',
      clientId: 'c1',
    })
  })
  it('reads them from the settings file, the environment winning', () => {
    const file = '# comment\nVIBASE_URL=http://localhost:8787\nVIBASE_CLIENT_ID="from-file"\n'
    expect(resolveConfig({}, file)).toEqual({ vibaseUrl: 'http://localhost:8787', clientId: 'from-file' })
    expect(resolveConfig({ VIBASE_CLIENT_ID: 'from-env' }, file).clientId).toBe('from-env')
  })
  it('names the missing variable', () => {
    expect(() => resolveConfig({ VIBASE_CLIENT_ID: 'c1' })).toThrow(/VIBASE_URL/)
    expect(() => resolveConfig({ VIBASE_URL: 'http://localhost:8787' })).toThrow(/VIBASE_CLIENT_ID/)
  })
})

describe('build', () => {
  it.each([
    ['VIBASE_URL', { VIBASE_CLIENT_ID: 'c1' }],
    ['VIBASE_CLIENT_ID', { VIBASE_URL: 'http://localhost:8787' }],
  ])('refuses without %s, naming it, and writes nothing', async (name, env) => {
    const out = join(scratch(), 'dist')
    await expect(buildApp(env, out, '')).rejects.toThrow(name)
    expect(existsSync(out)).toBe(false)
  })

  it('with both set, writes a page whose bundle carries the values and the SDK', async () => {
    const out = join(scratch(), 'dist')
    await buildApp({ VIBASE_URL: 'http://localhost:8787', VIBASE_CLIENT_ID: 'client-xyz' }, out, '')
    const files = readdirSync(out, { recursive: true }).map(String)
    expect(files).toContain('index.html')
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    const entry = /<script type="module" src="\/([^"]+)"/.exec(html)![1]!
    const js = readFileSync(join(out, entry), 'utf8')
    expect(js).toContain('client-xyz')
    expect(js).toContain('http://localhost:8787')
    expect(js).toContain('state_mismatch') // from @vibase/sdk's browserSignIn
  })
})
