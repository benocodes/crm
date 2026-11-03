import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { ASSETS_DIR, buildConnect } from './build-connect.js'

// [[UI30]] D3: the page is built into the asset directory that wrangler.jsonc names; nothing of the E2E harness reaches it.

const PKG = fileURLToPath(new URL('..', import.meta.url))
let out: string
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'connect-build-'))
  await buildConnect(out)
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))

describe('buildConnect', () => {
  it('writes the three files under connect/ (so /connect/<file> is the asset path) and nothing at the root', () => {
    const files = walk(out).map((f) => f.slice(out.length + 1)).sort()
    expect(files).toEqual(['connect/connect.css', 'connect/connect.js', 'connect/index.html'])
  })

  it('the HTML references its script and stylesheet by absolute /connect/ paths, with no inline script, handler or style', () => {
    const html = readFileSync(join(out, 'connect/index.html'), 'utf8')
    expect(html).toContain('src="/connect/connect.js"')
    expect(html).toContain('href="/connect/connect.css"')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=/i)
  })

  it('the script is a single browser bundle with no source map comment, eval or Function constructor', () => {
    const js = readFileSync(join(out, 'connect/connect.js'), 'utf8')
    expect(js.length).toBeGreaterThan(1000)
    expect(js).not.toMatch(/sourceMappingURL/)
    expect(js).not.toMatch(/\beval\(|new Function\(/)
    expect(js).not.toMatch(/\bfrom\s*["']|\brequire\(/)
  })

  it('pins clerk-js 6.39.1 and loads it from the issuer in discovery, not from a baked-in host', () => {
    const js = readFileSync(join(out, 'connect/connect.js'), 'utf8')
    expect(js).toContain('@clerk/clerk-js@6.39.1/dist/clerk.browser.js')
    expect(js).not.toMatch(/clerk\.accounts\.dev|clerk\.hq\.vibase\.ai|pk_(test|live)_/)
  })

  it('the E2E harness is not in the built assets (a boundary: @clerk/testing and Playwright are test-only)', () => {
    for (const f of walk(out)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@clerk\/testing|@playwright|playwright/i)
  })
})

describe('the page source and the asset directory', () => {
  it('no non-test file under src/ names @clerk/testing or @playwright', () => {
    for (const f of walk(join(PKG, 'src')).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@clerk\/testing|@playwright|playwright/i)
  })

  it('the default output is the directory wrangler.jsonc names, and it is ignored by git', () => {
    const cfg = unstable_readConfig({ config: join(PKG, 'wrangler.jsonc') })
    expect(resolve(dirname(join(PKG, 'wrangler.jsonc')), cfg.assets!.directory!)).toBe(ASSETS_DIR)
    expect(ASSETS_DIR.startsWith(join(PKG, 'dist'))).toBe(true)
    expect(readFileSync(join(PKG, '../../.gitignore'), 'utf8')).toMatch(/^dist\/$/m)
  })

  it('dev and every deploy path build the page first', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toContain('build-connect')
    expect(pkg.scripts.dev).toMatch(/^pnpm build && /)
    expect(readFileSync(join(PKG, 'scripts/smoke-worker.ts'), 'utf8')).toContain('buildConnect(')
  })

  it('the E2E and the page tests are devDependencies only', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    for (const d of ['@playwright/test', '@clerk/testing', 'happy-dom']) {
      expect(pkg.devDependencies[d], d).toBeTruthy()
      expect(pkg.dependencies[d], d).toBeUndefined()
    }
  })
})
