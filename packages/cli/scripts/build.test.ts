import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCli } from './build.js'

const CLI_PKG = new URL('../package.json', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ops210-cli-')); dirs.push(d); return d }
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
