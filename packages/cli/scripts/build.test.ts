import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCli } from './build.js'

const CLI_PKG = new URL('../package.json', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ops210-cli-'))
  dirs.push(d)
  return d
}
const version = (file: string) => execFileSync('node', [file, '--version'], { encoding: 'utf8' }).trim()

describe('D1 one product version (OPS237: the fixed group of the two workspace packages)', () => {
  it("the built CLI prints vibase-cli/<the cli workspace package's version>", async () => {
    const out = join(tmp(), 'vibase.js')
    await buildCli({ outfile: out })
    expect(version(out)).toBe(`vibase-cli/${JSON.parse(readFileSync(CLI_PKG, 'utf8')).version}`)
  })
  it('a version passed by release:build (the verified fixed-group version) is the one it prints', async () => {
    const out = join(tmp(), 'vibase.js')
    await buildCli({ outfile: out, version: '7.8.9' })
    expect(version(out)).toBe('vibase-cli/7.8.9')
  })
  it('changing only the cli package.json version changes it', async () => {
    const d = tmp()
    const pkg = join(d, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: '@vibase/cli', version: '6.5.4' }))
    const out = join(d, 'vibase.js')
    await buildCli({ outfile: out, packageJson: pkg })
    expect(version(out)).toBe('vibase-cli/6.5.4')
  })
  it('a cli package.json without a version refuses', async () => {
    const d = tmp()
    const pkg = join(d, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: '@vibase/cli' }))
    await expect(buildCli({ outfile: join(d, 'v.js'), packageJson: pkg })).rejects.toThrow(/no version/)
  })
})

// DX694 D8: the bundle stays small and import-clean; the translator is the developer's, loaded at run time.
describe('DX694 D8 the bundle', () => {
  const MAX_BYTES = 100 * 1024
  /** The ways a bundle can reach a package at load time: a static import, a side-effect import, a require call or a re-export. */
  const staticReferences = (text: string, name: string) => {
    const n = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    return [
      ...text.matchAll(new RegExp(`(?:from|import)\\s*\\(?\\s*["'](${n})(?:/[^"']*)?["']`, 'g')),
      ...text.matchAll(new RegExp(`\\brequire\\(\\s*["'](${n})(?:/[^"']*)?["']`, 'g')),
    ].map((m) => m[0])
  }
  it('is under 100 KB', async () => {
    const out = join(tmp(), 'vibase.js')
    await buildCli({ outfile: out })
    expect(readFileSync(out).length).toBeLessThan(MAX_BYTES)
  })
  it('holds no static import or require of openapi-typescript, typescript or @vibase/api', async () => {
    const out = join(tmp(), 'vibase.js')
    await buildCli({ outfile: out })
    const text = readFileSync(out, 'utf8')
    for (const name of ['openapi-typescript', 'typescript', '@vibase/api'])
      expect(staticReferences(text, name), name).toEqual([])
  })
  it('the scan catches each form (absence mutation fixture)', () => {
    for (const bad of [
      `import openapiTS from "openapi-typescript";`,
      `import "typescript";`,
      `const ts = require("typescript");`,
      `export { x } from '@vibase/api';`,
      `import("openapi-typescript/dist/index.mjs")`,
    ])
      expect(
        ['openapi-typescript', 'typescript', '@vibase/api'].some((n) => staticReferences(bad, n).length > 0),
        bad,
      ).toBe(true)
    expect(staticReferences(`import fs from "node:fs"; createRequire(x).resolve("a")`, 'typescript')).toEqual([])
  })
})
