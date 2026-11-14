import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildUi } from './build-ui.js'

// [[UI246]] D2: one Preact bundle for the auth pages under /ui/, no React in it; the Worker bundle holds none of it.
const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
let out: string
let metafile: { inputs: Record<string, unknown> }
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'ui-build-'))
  metafile = await buildUi(out)
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
/** The package a metafile input path belongs to (`node_modules/.pnpm/<name>@<ver>.../node_modules/<name>/...`), or the path itself. */
const packageOf = (input: string): string => {
  const m = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)
  return m ? m[1]! : input
}

describe('buildUi (the pages bundle)', () => {
  it('writes index.html, app.js and ui.css under ui/ (so /ui/<file> is the asset path) and nothing at the root', () => {
    expect(walk(out).map((f) => f.slice(out.length + 1)).sort()).toEqual(['ui/app.js', 'ui/index.html', 'ui/ui.css'])
  })

  it('the HTML references its script and stylesheet by absolute /ui/ paths, with no inline script, handler or style', () => {
    const html = readFileSync(join(out, 'ui/index.html'), 'utf8')
    expect(html).toContain('src="/ui/app.js"')
    expect(html).toContain('href="/ui/ui.css"')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=/i)
  })

  it('the stylesheet is @vibase/ui\'s ui.css, byte for byte', () => {
    expect(readFileSync(join(out, 'ui/ui.css'), 'utf8')).toBe(readFileSync(fileURLToPath(new URL('../../ui/src/ui.css', import.meta.url)), 'utf8'))
  })

  it('the metafile holds preact and no react or react-dom package', () => {
    const pkgs = new Set(Object.keys(metafile.inputs).map(packageOf))
    expect(pkgs.has('preact')).toBe(true)
    expect(pkgs.has('react')).toBe(false)
    expect(pkgs.has('react-dom')).toBe(false)
    expect(Object.keys(metafile.inputs).some((i) => /(^|\/)ui\/src\//.test(i))).toBe(true)
  })

  // [[UI247]] D5: the scope catalogue is embedded at build time from its dependency-free leaf; the bundle never holds `@vibase/api`'s index or any other of its modules.
  it('the page bundle holds the scope catalogue leaf and no other @vibase/api module', () => {
    const api = Object.keys(metafile.inputs).filter((i) => /(^|\/)api\/src\//.test(i))
    expect(api.map((i) => i.replace(/^.*api\/src\//, ''))).toEqual(['auth/scope-descriptions.ts'])
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
    expect(js).not.toMatch(/\bfrom\s*["']|\brequire\(/)
  })
})

describe('the Worker bundle', () => {
  it('holds no preact, no @vibase/ui and no page module', async () => {
    // The Worker's own bundling (wrangler's esbuild; `node:*` and the runtime module stay external), with a metafile.
    const res = await build({ entryPoints: [WORKER], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], target: 'es2022', external: ['cloudflare:workers', 'node:*'], logLevel: 'silent' })
    const inputs = Object.keys(res.metafile.inputs)
    expect(inputs.length).toBeGreaterThan(100)
    expect(inputs.filter((i) => packageOf(i) === 'preact' || /preact/.test(i))).toEqual([])
    expect(inputs.filter((i) => /(^|\/)ui\/src\/|@vibase\/ui\//.test(i))).toEqual([])
    expect(inputs.filter((i) => /(^|\/)src\/ui\//.test(i))).toEqual([])
  }, 60_000)
})
