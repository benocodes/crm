// [[OPS210]] D8 items (2), (4), (5), (9) as functions over a package directory: the exact file lists of D3, the package.json fields, the versions, the client's purity
// and the `exports` of D23 (a). `release:check` calls them on the extracted and the installed packages; here each guard is shown refusing its fault.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sources } from './fixtures.js'
import { CLIENT_MARKERS, assertClientLayout, assertCommit, assertExportsResolve, assertServerLayout, clientProblems, serverProblems } from './layout.js'
import { stageClient, stageServer } from './stage.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
const put = (dir: string, f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text) }
const editJson = (file: string, f: (o: Record<string, any>) => void) => { const o = JSON.parse(readFileSync(file, 'utf8')); f(o); writeFileSync(file, JSON.stringify(o, null, 2)) }
function client() {
  const s = sources()
  dirs.push(s.root)
  const dir = tmp('ops240-client-')
  stageClient({ ...s, outDir: dir })
  return { dir, s }
}
function server() {
  const s = sources()
  dirs.push(s.root)
  const dir = tmp('ops240-server-')
  stageServer({ ...s, outDir: dir })
  return { dir, s }
}

describe('D8 (2), (4), (5): the client package', () => {
  it('a clean client passes', () => {
    const { dir, s } = client()
    expect(clientProblems(dir, s.version)).toEqual([])
    expect(() => assertClientLayout(dir, s.version)).not.toThrow()
  })
  it('an extra file is refused by name (the exact list of D3)', () => {
    const { dir, s } = client()
    put(dir, 'cli/extra.js', 'x')
    expect(clientProblems(dir, s.version).join('\n')).toContain('cli/extra.js')
    expect(() => assertClientLayout(dir, s.version)).toThrow(/cli\/extra\.js/)
  })
  it('a missing file is refused by name', () => {
    const { dir, s } = client()
    unlinkSync(join(dir, 'LICENSE'))
    expect(() => assertClientLayout(dir, s.version)).toThrow(/LICENSE/)
  })
  it('a release.json in the client is refused (it deploys nothing)', () => {
    const { dir, s } = client()
    put(dir, 'release.json', '{}')
    expect(() => assertClientLayout(dir, s.version)).toThrow(/release\.json/)
  })
  it.each([['dependencies', { wrangler: '4.149.0' }], ['dependencies', { left: '1.0.0' }], ['optionalDependencies', { x: '1.0.0' }], ['peerDependencies', { x: '1.0.0' }]])('a %s entry in the client package.json is refused', (key, value) => {
    const { dir, s } = client()
    editJson(join(dir, 'package.json'), (o) => { o[key as string] = value })
    expect(() => assertClientLayout(dir, s.version)).toThrow(new RegExp(String(key)))
  })
  it('an empty dependencies object is allowed (absent or empty)', () => {
    const { dir, s } = client()
    editJson(join(dir, 'package.json'), (o) => { o.dependencies = {} })
    expect(clientProblems(dir, s.version)).toEqual([])
  })
  it.each(CLIENT_MARKERS)('an instance marker %s in cli/vibase.js is refused', (marker) => {
    const { dir, s } = client()
    writeFileSync(join(dir, 'cli', 'vibase.js'), `${readFileSync(join(dir, 'cli', 'vibase.js'), 'utf8')}\n// ${marker}\n`)
    expect(() => assertClientLayout(dir, s.version)).toThrow(new RegExp(marker.replace(/[.]/g, '\\.')))
  })
  it('the markers are strings only the instance entry carries, and never the redirect text', () => {
    expect(CLIENT_MARKERS).toContain('ops.init_deployment')
    for (const m of CLIENT_MARKERS) expect('npx @vibase/server-d1@1.2.3 <command> …').not.toContain(m)
  })
  it('a wrong name, version, bin or access is refused', () => {
    for (const [key, v] of [['name', 'vibase'], ['version', '9.9.9'], ['bin', { vibase: 'cli/other.js' }], ['publishConfig', { access: 'restricted' }]] as const) {
      const { dir, s } = client()
      editJson(join(dir, 'package.json'), (o) => { o[key] = v })
      expect(() => assertClientLayout(dir, s.version), key).toThrow(new RegExp(key))
    }
  })
})

describe('D8 (2), (3), (4), (9): the server package', () => {
  it('a clean server passes', () => {
    const { dir, s } = server()
    expect(serverProblems(dir, s.version)).toEqual([])
    expect(() => assertServerLayout(dir, s.version)).not.toThrow()
  })
  it('an extra root file, a client in the server, an asset outside assets/connect and a migration release.json does not list are each refused by name', () => {
    for (const f of ['notes.txt', 'cli/vibase.js', 'assets/other/x.js', 'migrations/0003_c.sql', 'worker/worker.js.map']) {
      const { dir, s } = server()
      put(dir, f, 'x')
      expect(() => assertServerLayout(dir, s.version), f).toThrow(new RegExp(f.replace(/[.]/g, '\\.')))
    }
  })
  it('a missing worker, base config or release.json is refused by name', () => {
    for (const f of ['worker/worker.js', 'wrangler.base.jsonc', 'release.json', 'cli/server.js']) {
      const { dir, s } = server()
      unlinkSync(join(dir, f))
      expect(() => assertServerLayout(dir, s.version), f).toThrow(new RegExp(f.replace(/[.]/g, '\\.')))
    }
  })
  it('a server version unequal to the product version is refused, in package.json and in release.json', () => {
    const a = server()
    editJson(join(a.dir, 'package.json'), (o) => { o.version = '0.2.0' })
    expect(() => assertServerLayout(a.dir, a.s.version)).toThrow(/version/)
    const b = server()
    editJson(join(b.dir, 'release.json'), (o) => { o.version = '0.2.0' })
    expect(() => assertServerLayout(b.dir, b.s.version)).toThrow(/version/)
  })
  it('a release.json that does not name @vibase/server-d1 is refused', () => {
    const { dir, s } = server()
    editJson(join(dir, 'release.json'), (o) => { o.name = 'vibase' })
    expect(() => assertServerLayout(dir, s.version)).toThrow(/@vibase\/server-d1/)
  })
  it('dependencies other than one exact wrangler equal to release.json are refused', () => {
    for (const deps of [{ wrangler: '^4.149.0' }, { wrangler: '4.149.0', left: '1.0.0' }, { wrangler: '4.0.0' }, {}]) {
      const { dir, s } = server()
      editJson(join(dir, 'package.json'), (o) => { o.dependencies = deps })
      expect(() => assertServerLayout(dir, s.version), JSON.stringify(deps)).toThrow(/dependencies/)
    }
  })
  it('an exports entry that names a file the package does not ship is refused by entry', () => {
    const { dir, s } = server()
    editJson(join(dir, 'package.json'), (o) => { o.exports['./worker'] = './worker/missing.js' })
    expect(() => assertServerLayout(dir, s.version)).toThrow(/\.\/worker/)
  })
  it('a missing exports key (a changed set) is refused', () => {
    const { dir, s } = server()
    editJson(join(dir, 'package.json'), (o) => { delete o.exports['./release.json'] })
    expect(() => assertServerLayout(dir, s.version)).toThrow(/exports/)
  })
})

describe('D8 (9): every exports entry resolves from a consumer directory', () => {
  const consumer = (mutate?: (o: Record<string, any>) => void) => {
    const { dir, s } = server()
    if (mutate) editJson(join(dir, 'package.json'), mutate)
    const root = tmp('ops240-consumer-')
    cpSync(dir, join(root, 'node_modules', '@vibase', 'server-d1'), { recursive: true })
    return { root, s }
  }
  it('resolves each entry (a pattern through one real file) to a file inside the installed package', () => {
    const { root } = consumer()
    const got = assertExportsResolve(root)
    expect(got.map((g) => g.entry)).toEqual(['./worker', './wrangler.base.jsonc', './release.json', './migrations/*', './assets/*', './package.json'])
    for (const g of got) expect(g.resolved).toContain(join('node_modules', '@vibase', 'server-d1'))
  })
  it('refuses an entry whose target is not shipped (Node says so)', () => {
    const { root } = consumer((o) => { o.exports['./worker'] = './worker/missing.js' })
    expect(() => assertExportsResolve(root)).toThrow(/\.\/worker/)
  })
  it('refuses a pattern that matches no shipped file', () => {
    const { root } = consumer((o) => { o.exports['./assets/*'] = './nowhere/*' })
    expect(() => assertExportsResolve(root)).toThrow(/\.\/assets\/\*/)
  })
})

describe('D8 (4): the commit is the build\'s', () => {
  it('accepts a 40-hex sha and the -dirty form, refuses anything else', () => {
    expect(() => assertCommit('a'.repeat(40))).not.toThrow()
    expect(() => assertCommit(`${'b'.repeat(40)}-dirty`)).not.toThrow()
    for (const bad of ['abc1234', '', 'main', `${'a'.repeat(40)}-wip`]) expect(() => assertCommit(bad), bad).toThrow(/commit/)
  })
})
