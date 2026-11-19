// [[UI445]] cycle 1, group 5 (D9 bundle part, D10): the React gallery's bundle contents and budget, measured in the gate.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { Metafile } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildGalleryReact, packagesIn } from './build-gallery-react'

/** D10: gzipped bytes. */
export const BUDGET = { jsBytes: 100 * 1024, cssBytes: 20 * 1024 }

/** What is wrong with a gallery bundle's contents; empty when it is as D9 requires. */
export const contentsProblems = (metafile: Metafile): string[] => {
  const pkgs = packagesIn(metafile)
  return [
    ...['react', 'react-dom'].filter((p) => !pkgs.includes(p)).map((p) => `missing ${p}`),
    ...(pkgs.includes('preact') ? ['contains preact'] : []),
  ]
}

const GALLERY_SRC = fileURLToPath(new URL('../gallery-react/', import.meta.url))
const gz = (file: string) => gzipSync(readFileSync(file)).length
let out = ''
let metafile: Metafile

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'gallery-react-'))
  metafile = (await buildGalleryReact(out)).metafile
}, 60_000)

describe('React gallery bundle', () => {
  it('contains react and react-dom and no preact', () => {
    expect(contentsProblems(metafile)).toEqual([])
  })

  it('has teeth: a metafile with a node_modules/preact input turns the contents check red ([[UI447]] D6)', () => {
    const bad = {
      inputs: {
        'node_modules/react/index.js': { bytes: 1, imports: [] },
        'node_modules/react-dom/index.js': { bytes: 1, imports: [] },
        'node_modules/preact/compat/dist/compat.module.js': { bytes: 1, imports: [] },
      },
      outputs: {},
    } as Metafile
    expect(contentsProblems(bad)).toContain('contains preact')
  })

  it('its stylesheet holds rules for classes the gallery uses, and none for one it does not', () => {
    const css = readFileSync(join(out, 'gallery.css'), 'utf-8')
    expect(css).toContain('.bg-primary{')
    expect(css).toContain('.text-destructive{')
    expect(css).not.toContain('.bg-yellow-500{')
  })

  it('its stylesheet holds a rule for a class only a component under src/components uses (@source for src/components)', () => {
    const css = readFileSync(join(out, 'gallery.css'), 'utf-8')
    expect(css).toContain('.max-h-48{')
    expect(readFileSync(join(GALLERY_SRC, 'gallery.tsx'), 'utf-8')).not.toContain('max-h-48')
  })

  it('stays within the budget (100 KB gzipped JS, 20 KB gzipped CSS), for the components, composites and lists pages', () => {
    const css = gz(join(out, 'gallery.css'))
    for (const bundle of ['gallery.js', 'composites.js', 'lists.js']) {
      const js = gz(join(out, bundle))
      console.log(`react gallery gzipped: ${bundle} ${js} bytes, gallery.css ${css} bytes`)
      expect(js, bundle).toBeLessThanOrEqual(BUDGET.jsBytes)
    }
    expect(css).toBeLessThanOrEqual(BUDGET.cssBytes)
  })

  it('builds the composites page with lucide-react and no preact (UI443 P3)', () => {
    expect(packagesIn(metafile)).toContain('lucide-react')
    expect(readFileSync(join(out, 'composites.html'), 'utf-8')).toContain('composites.js')
  })
})
