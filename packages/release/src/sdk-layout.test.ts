// [[OPS693]] D2, D3: the staged `@vibase/sdk` package and the layout assertion over it. Each rule of D3 is shown refusing its fault (the matrix), and a clean staged package passes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sdkSources } from './fixtures.js'
import { assertSdkLayout, sdkProblems } from './layout.js'
import { listFiles } from './manifest.js'
import { SDK_EXPORTS, sdkPackageJson, stageSdk } from './stage.js'
import { ReleaseRefusal } from './errors.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function staged() {
  const s = sdkSources()
  dirs.push(s.root)
  const dir = mkdtempSync(join(tmpdir(), 'ops693-sdk-'))
  dirs.push(dir)
  stageSdk({ ...s, outDir: dir })
  return { dir, s }
}
const put = (dir: string, f: string, text: string) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true })
  writeFileSync(join(dir, f), text)
}
const editJson = (file: string, f: (o: Record<string, any>) => void) => {
  const o = JSON.parse(readFileSync(file, 'utf8'))
  f(o)
  writeFileSync(file, JSON.stringify(o, null, 2))
}
const problems = (dir: string, v: string) => sdkProblems(dir, v).join('\n')

describe('D2: the staged package', () => {
  it('holds LICENSE, README.md, package.json and dist/*.js with a .d.ts each, nothing else', () => {
    const { dir } = staged()
    expect(listFiles(dir).sort()).toEqual(
      [
        'LICENSE',
        'README.md',
        'package.json',
        'dist/index.js',
        'dist/index.d.ts',
        'dist/client.js',
        'dist/client.d.ts',
      ].sort(),
    )
  })
  it('its package.json is the generated one: type module, sideEffects false, engines >=22, public, exports exactly "." and "./package.json", no bin, no dependencies', () => {
    const { dir, s } = staged()
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(pkg).toEqual(sdkPackageJson(s.version))
    expect(pkg.name).toBe('@vibase/sdk')
    expect(pkg.version).toBe(s.version)
    expect(pkg.type).toBe('module')
    expect(pkg.sideEffects).toBe(false)
    expect(pkg.engines).toEqual({ node: '>=22' })
    expect(pkg.publishConfig).toEqual({ access: 'public' })
    expect(pkg.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './package.json': './package.json',
    })
    expect(SDK_EXPORTS).toEqual(pkg.exports)
    for (const k of ['bin', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      expect(pkg).not.toHaveProperty(k)
  })
})

describe('D3: the layout assertion (the matrix)', () => {
  it('a clean staged package passes', () => {
    const { dir, s } = staged()
    expect(sdkProblems(dir, s.version)).toEqual([])
    expect(() => assertSdkLayout(dir, s.version)).not.toThrow()
  })
  it('an extra file is refused, naming it', () => {
    const { dir, s } = staged()
    put(dir, 'notes.txt', 'x')
    put(dir, 'dist/data.json', '{}')
    expect(problems(dir, s.version)).toMatch(/notes\.txt.*extra/)
    expect(problems(dir, s.version)).toMatch(/dist\/data\.json.*extra/)
  })
  it.each(['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md', 'package.json'])(
    'a missing %s is refused, naming it',
    (f) => {
      const { dir, s } = staged()
      unlinkSync(join(dir, f))
      expect(problems(dir, s.version)).toMatch(new RegExp(`${f.replace('.', '\\.')}.*missing`))
    },
  )
  it('a .js without its .d.ts, and a .d.ts without its .js, are refused, naming the orphan', () => {
    const { dir, s } = staged()
    put(dir, 'dist/orphan.js', 'export {}\n')
    put(dir, 'dist/lonely.d.ts', 'export {}\n')
    expect(problems(dir, s.version)).toMatch(/dist\/orphan\.js.*orphan/)
    expect(problems(dir, s.version)).toMatch(/dist\/lonely\.d\.ts.*orphan/)
  })
  it.each([
    ['dist/generate/emit.js', 'dist/generate/emit.d.ts', /dist\/generate\/emit\.js.*generate/],
    ['dist/testing.js', 'dist/testing.d.ts', /dist\/testing\.js.*testing/],
  ])('%s (a complete pair) is still refused as forbidden', (js, dts, re) => {
    const { dir, s } = staged()
    put(dir, js, 'export {}\n')
    put(dir, dts, 'export {}\n')
    expect(problems(dir, s.version)).toMatch(re)
  })
  it.each([
    ['dist/client.js', "import { readFile } from 'node:fs'\n", /dist\/client\.js.*node:/],
    ['dist/client.js', "import x from '@vibase/api'\n", /dist\/client\.js.*@vibase\//],
    ['dist/client.d.ts', "import type { X } from 'node:http'\nexport type Y = X\n", /dist\/client\.d\.ts.*node:/],
    ['dist/client.d.ts', "export type { Z } from '@vibase/storage'\n", /dist\/client\.d\.ts.*@vibase\//],
    ['dist/client.js', "const m = await import('node:fs')\n", /dist\/client\.js.*node:/],
  ])('a node: or @vibase/ specifier in %s is refused', (file, text, re) => {
    const { dir, s } = staged()
    put(dir, file, text)
    expect(problems(dir, s.version)).toMatch(re)
  })
  it('a README that tells the reader to run pnpm -C packages/ is refused', () => {
    const { dir, s } = staged()
    put(dir, 'README.md', '# sdk\n\nRun `pnpm -C packages/sdk generate`.\n')
    expect(problems(dir, s.version)).toMatch(/README\.md.*pnpm -C packages\//)
  })
  it.each([
    ['name', (o: any) => (o.name = '@vibase/other')],
    ['version', (o: any) => (o.version = '9.9.9')],
    ['type', (o: any) => (o.type = 'commonjs')],
    ['sideEffects', (o: any) => (o.sideEffects = true)],
    ['engines', (o: any) => (o.engines = { node: '>=18' })],
    ['publishConfig', (o: any) => (o.publishConfig = { access: 'restricted' })],
    ['license', (o: any) => (o.license = 'ISC')],
    ['exports', (o: any) => (o.exports = { '.': './dist/index.js' })],
    ['exports', (o: any) => (o.exports = { ...o.exports, './generate': './dist/generate/index.js' })],
    ['exports', (o: any) => delete o.exports],
    ['private', (o: any) => (o.private = true)],
    ['main', (o: any) => (o.main = 'dist/index.js')],
  ])('a manifest whose %s differs from D2 is refused, naming the field', (field, mutate) => {
    const { dir, s } = staged()
    editJson(join(dir, 'package.json'), mutate)
    expect(problems(dir, s.version)).toMatch(new RegExp(`package\\.json ${field}`))
  })
  it.each(['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies'])(
    'a non-empty %s is refused',
    (k) => {
      const { dir, s } = staged()
      editJson(
        join(dir, 'package.json'),
        (o) => (o[k] = k.startsWith('bundle') || k.startsWith('bundled') ? ['x'] : { x: '1.0.0' }),
      )
      expect(problems(dir, s.version)).toMatch(new RegExp(`package\\.json ${k}`))
    },
  )
  it('a bin is refused', () => {
    const { dir, s } = staged()
    editJson(join(dir, 'package.json'), (o) => (o.bin = { vibase: 'dist/index.js' }))
    expect(problems(dir, s.version)).toMatch(/package\.json bin/)
  })
  it('a version that is not the release version is refused, naming both', () => {
    const { dir } = staged()
    expect(problems(dir, '0.2.0')).toMatch(/0\.1\.0.*0\.2\.0/)
  })
  it('the assert form throws a ReleaseRefusal carrying the problems', () => {
    const { dir, s } = staged()
    put(dir, 'notes.txt', 'x')
    expect(() => assertSdkLayout(dir, s.version)).toThrow(ReleaseRefusal)
    expect(() => assertSdkLayout(dir, s.version)).toThrow(/notes\.txt/)
  })
})
