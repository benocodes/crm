// Group 5, build half ([[UI254]] D3d, D4): the gallery bundle built with the exported esbuild options ships Preact and no React.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { esbuildOptions } from '../src/esbuild-options'
import { buildGallery, packagesIn } from './build-gallery'

const outDir = () => mkdtempSync(join(tmpdir(), 'gallery-'))

describe('gallery build', () => {
  it('bundles preact and no react or react-dom package', async () => {
    const { metafile } = await buildGallery(outDir())
    const packages = packagesIn(metafile)
    expect(packages).toContain('preact')
    expect(packages).not.toContain('react')
    expect(packages).not.toContain('react-dom')
  })

  it('has teeth: without the `react` alias entry the same build pulls the react package in', async () => {
    const { react: _dropped, ...alias } = esbuildOptions.alias
    const { metafile } = await buildGallery(outDir(), { ...esbuildOptions, alias })
    expect(packagesIn(metafile)).toContain('react')
  })

  it('writes the page, its bundle and the stylesheet', async () => {
    const dir = outDir()
    const { files } = await buildGallery(dir)
    expect(files.sort()).toEqual(['gallery.css', 'gallery.js', 'index.html'])
  })
})
