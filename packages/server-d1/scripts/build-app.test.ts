import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './build-app.js'

// [[UI460]] D6 (group 6): the workspace app is a third page build into `app/` of the assets directory: one React bundle, Tailwind's stylesheet, within 150 KB JS / 25 KB CSS gzipped.
export const APP_JS_BUDGET = 150 * 1024
export const APP_CSS_BUDGET = 25 * 1024
let out: string
let metafile: { inputs: Record<string, unknown> }
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'app-build-'))
  metafile = await buildApp(out)
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const packageOf = (input: string): string => {
  const m = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)
  return m ? m[1]! : input
}

describe('buildApp', () => {
  it('writes app.js, app.css and index.html under app/ (so /app/<file> is the asset path) and nothing at the root', () => {
    expect(
      walk(out)
        .map((f) => f.slice(out.length + 1))
        .sort(),
    ).toEqual(['app/app.css', 'app/app.js', 'app/index.html'])
  })

  it('the HTML references its script and stylesheet by absolute /app/ paths, with no inline script, handler or style, and a div root (not a landmark)', () => {
    const html = readFileSync(join(out, 'app/index.html'), 'utf8')
    expect(html).toContain('src="/app/app.js"')
    expect(html).toContain('href="/app/app.css"')
    expect(html).toContain('<div id="root">')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=/i)
  })

  it('the stylesheet is the Tailwind build and holds the shell’s classes', () => {
    const css = readFileSync(join(out, 'app/app.css'), 'utf8')
    expect(css.length).toBeGreaterThan(2000)
    expect(css).toContain('--primary')
    expect(css).toMatch(/\.md\\:flex-row/)
  })

  // UI460 E2E: the dark-mode axe check caught a button mid-transition (as UI446's did on the auth pages); the app switches transitions off the same way.
  it('the stylesheet switches transitions off under the mount wrapper', () => {
    expect(readFileSync(join(out, 'app/app.css'), 'utf8')).toContain(
      'transition-none\\! *{transition-property:none!important}',
    )
  })

  it('the metafile holds react, react-dom, lucide-react and the component set, and no preact and no Preact-layer module', () => {
    const inputs = Object.keys(metafile.inputs)
    const pkgs = new Set(inputs.map(packageOf))
    for (const p of ['react', 'react-dom', 'lucide-react']) expect(pkgs.has(p), p).toBe(true)
    expect(inputs.some((i) => /(^|\/)ui\/src\/components\//.test(i))).toBe(true)
    expect(inputs.filter((i) => packageOf(i) === 'preact' || /preact/.test(i))).toEqual([])
    expect(inputs.filter((i) => /(^|\/)ui\/src\/[^/]+$/.test(i))).toEqual([])
  })

  it('the bundle holds no @vibase/api module and no connect-page module (the seam lives in src/app/session)', () => {
    const inputs = Object.keys(metafile.inputs)
    expect(inputs.filter((i) => /(^|\/)api\/src\//.test(i))).toEqual([])
    expect(inputs.filter((i) => /(^|\/)src\/connect\//.test(i))).toEqual([])
    expect(inputs.some((i) => /(^|\/)src\/app\/session\/seam\.ts$/.test(i))).toBe(true)
  })

  it('the script is a single browser bundle with no source map comment, eval or import', () => {
    const js = readFileSync(join(out, 'app/app.js'), 'utf8')
    expect(js.length).toBeGreaterThan(5000)
    expect(js).not.toMatch(/sourceMappingURL/)
    expect(js).not.toMatch(/\beval\(|new Function\(/)
    expect(js).not.toMatch(/\brequire\(|\bimport\(|(^|[;}])\s*(import|export)\s*[\w{*"']/)
  })

  it('stays within the budget: 150 KB gzipped JS, 25 KB gzipped CSS', () => {
    const js = gzipSync(readFileSync(join(out, 'app/app.js'))).length
    const css = gzipSync(readFileSync(join(out, 'app/app.css'))).length
    console.log(`app bundle: ${js} B gz JS, ${css} B gz CSS`)
    expect(js).toBeLessThanOrEqual(APP_JS_BUDGET)
    expect(css).toBeLessThanOrEqual(APP_CSS_BUDGET)
  })
})
