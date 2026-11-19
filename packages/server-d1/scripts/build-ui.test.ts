import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildUi } from './build-ui.js'

// [[UI446]] D1, D4, D7 (on [[UI246]] D2): one React bundle for the auth pages under /ui/, built from `@vibase/ui/components` with Tailwind's stylesheet, no Preact in it; the Worker bundle holds none of it.
/** [[UI445]] D10's limits, kept by [[UI446]] D7: gzipped bytes. */
export const JS_BUDGET = 100 * 1024
export const CSS_BUDGET = 20 * 1024
const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
let out: string
let metafile: { inputs: Record<string, unknown> }
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'ui-build-'))
  metafile = await buildUi(out)
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
/** The package a metafile input path belongs to (`node_modules/.pnpm/<name>@<ver>.../node_modules/<name>/...`), or the path itself. */
const packageOf = (input: string): string => {
  const m = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)
  return m ? m[1]! : input
}

describe('buildUi (the pages bundle)', () => {
  it('writes index.html, app.js and ui.css under ui/ (so /ui/<file> is the asset path) and nothing at the root', () => {
    expect(
      walk(out)
        .map((f) => f.slice(out.length + 1))
        .sort(),
    ).toEqual(['ui/app.js', 'ui/index.html', 'ui/ui.css'])
  })

  it('the HTML references its script and stylesheet by absolute /ui/ paths, with no inline script, handler or style', () => {
    const html = readFileSync(join(out, 'ui/index.html'), 'utf8')
    expect(html).toContain('src="/ui/app.js"')
    expect(html).toContain('href="/ui/ui.css"')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=/i)
  })

  it('the stylesheet is the Tailwind build ([[UI447]] D7: no comparison with the removed Preact `ui.css`), and holds a rule for a class only the page code uses', () => {
    const css = readFileSync(join(out, 'ui/ui.css'), 'utf8')
    expect(css).not.toContain('--vb-')
    // `max-w-132` is on the pages' mount wrapper (main.tsx) and nowhere in packages/ui/src/components, so only the page source scan can have produced it.
    const components = walk(fileURLToPath(new URL('../../ui/src/components', import.meta.url)))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(f, 'utf8'))
    expect(components.some((t) => t.includes('max-w-132'))).toBe(false)
    expect(css).toMatch(/\.max-w-132\{/)
  })

  // UI446 fix round 1: the E2E's dark-mode axe check caught buttons mid-transition (light-mode colours for 150 ms after the scheme flipped). The stylesheet must carry the dark tokens
  // under both spellings (the media query and data-theme), and the pages must switch transitions off.
  it('the stylesheet swaps every token the buttons use in dark mode, by media query and by data-theme, and the pages disable transitions', () => {
    const css = readFileSync(join(out, 'ui/ui.css'), 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(selector)
      expect(at, selector).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    const light = block(':root{')
    for (const dark of [
      block('@media (prefers-color-scheme:dark){:root:not([data-theme=light]){'),
      block(':root[data-theme=dark]{'),
    ]) {
      for (const token of [
        '--primary',
        '--primary-foreground',
        '--secondary',
        '--secondary-foreground',
        '--card',
        '--background',
      ]) {
        const value = (text: string) => new RegExp(`${token}:([^;}]+)`).exec(text)?.[1]
        expect(value(dark), token).toBeDefined()
        expect(value(dark), `${token} differs from light`).not.toBe(value(light))
      }
    }
    expect(css).toContain('transition-none\\! *{transition-property:none!important}')
  })

  it('the metafile holds react, react-dom and the component set, and no preact and no Preact-layer module', () => {
    const inputs = Object.keys(metafile.inputs)
    const pkgs = new Set(inputs.map(packageOf))
    expect(pkgs.has('react')).toBe(true)
    expect(pkgs.has('react-dom')).toBe(true)
    expect(inputs.some((i) => /(^|\/)ui\/src\/components\//.test(i))).toBe(true)
    expect(inputs.filter((i) => packageOf(i) === 'preact' || /preact/.test(i))).toEqual([])
    // `@vibase/ui` has no root entry: nothing directly under `packages/ui/src/` is bundled; `src/components/**` and `src/lib/**` are the layer.
    expect(inputs.filter((i) => /(^|\/)ui\/src\/[^/]+$/.test(i))).toEqual([])
  })

  it('the pages stay within the budget: 100 KB gzipped JS, 20 KB gzipped CSS', () => {
    const js = gzipSync(readFileSync(join(out, 'ui/app.js'))).length
    const css = gzipSync(readFileSync(join(out, 'ui/ui.css'))).length
    console.log(`auth pages bundle: ${js} B gz JS, ${css} B gz CSS`)
    expect(js).toBeLessThanOrEqual(JS_BUDGET)
    expect(css).toBeLessThanOrEqual(CSS_BUDGET)
  })

  // [[UI247]] D5: the scope catalogue is embedded at build time from its dependency-free leaf; the bundle never holds `@vibase/api`'s index or any other of its modules.
  // [[UI455]] adds `scope-areas` (the area catalogue and `NOT_DEFAULT_GRANT`): leaves only.
  it('the page bundle holds the scope catalogue leaves and no other @vibase/api module', () => {
    const api = Object.keys(metafile.inputs).filter((i) => /(^|\/)api\/src\//.test(i))
    expect(api.map((i) => i.replace(/^.*api\/src\//, '')).sort()).toEqual([
      'auth/scope-areas.ts',
      'auth/scope-descriptions.ts',
    ])
  })

  it('the script embeds a catalogue sentence and an OIDC scope sentence', () => {
    const js = readFileSync(join(out, 'ui/app.js'), 'utf8')
    expect(js).toContain('View deals (also called opportunities)')
    expect(js).toContain('Stay signed in: keep access until you sign out or the access is revoked')
  })

  it('the script is a single browser bundle with no source map comment, eval or import', () => {
    const js = readFileSync(join(out, 'ui/app.js'), 'utf8')
    expect(js.length).toBeGreaterThan(5000)
    expect(js).not.toMatch(/sourceMappingURL/)
    expect(js).not.toMatch(/\beval\(|new Function\(/)
    // No static import or export statement, dynamic import or require (a bare `from"` also occurs in Tailwind-merge's class-group names, so the statement forms are matched).
    expect(js).not.toMatch(/\brequire\(|\bimport\(|(^|[;}])\s*(import|export)\s*[\w{*"']/)
  })
})

describe('the Worker bundle', () => {
  it('holds no preact, no @vibase/ui and no page module', async () => {
    // The Worker's own bundling (wrangler's esbuild; `node:*` and the runtime module stay external), with a metafile.
    const res = await build({
      entryPoints: [WORKER],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      target: 'es2022',
      external: ['cloudflare:workers', 'node:*'],
      logLevel: 'silent',
    })
    const inputs = Object.keys(res.metafile.inputs)
    expect(inputs.length).toBeGreaterThan(100)
    expect(inputs.filter((i) => packageOf(i) === 'preact' || /preact/.test(i))).toEqual([])
    // The one module of @vibase/ui the Worker may hold is the plain-string CSP ([[UI445]] D6, one source with the gallery run); nothing else.
    expect(inputs.filter((i) => /(^|\/)ui\/src\/|@vibase\/ui\//.test(i))).toEqual(['../ui/src/csp.ts'])
    expect(inputs.filter((i) => /(^|\/)src\/ui\//.test(i))).toEqual([])
  }, 60_000)
})
