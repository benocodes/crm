import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCli } from './build.js'

const RELEASE_PKG = new URL('../../release/package.json', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ops210-cli-')); dirs.push(d); return d }
const version = (file: string) => execFileSync('node', [file, '--version'], { encoding: 'utf8' }).trim()

describe('D1 one product version', () => {
  it('the built CLI prints vibase-cli/<release version>', async () => {
    const out = join(tmp(), 'vibase.js')
    await buildCli({ outfile: out })
    expect(version(out)).toBe(`vibase-cli/${JSON.parse(readFileSync(RELEASE_PKG, 'utf8')).version}`)
  })
  it('changing only the release package.json version changes it', async () => {
    const d = tmp()
    const pkg = join(d, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: '@vibase/release', version: '7.8.9' }))
    const out = join(d, 'vibase.js')
    await buildCli({ outfile: out, releasePackageJson: pkg })
    expect(version(out)).toBe('vibase-cli/7.8.9')
  })
  it("@vibase/cli's own package.json no longer carries a version", () => {
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toBeUndefined()
  })
})
