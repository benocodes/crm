// Builds the React gallery ([[UI445]] D9) into `outDir` with the D8 helper, the way a React page build does:
//   pnpm -C packages/ui exec tsx scripts/build-gallery-react.ts [outDir]
// Output files: `gallery.js` (the bundle), `gallery.css` (the Tailwind stylesheet), `index.html`. Outside `src` and every export.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { buildStylesheet, reactBuildOptions } from '../build/index'

const GALLERY = fileURLToPath(new URL('../gallery-react/', import.meta.url))
export const GALLERY_REACT_OUT = fileURLToPath(new URL('../dist/gallery-react', import.meta.url))

export async function buildGalleryReact(
  outDir: string = GALLERY_REACT_OUT,
  options: BuildOptions = reactBuildOptions as unknown as BuildOptions,
  sources: readonly string[] = [GALLERY],
): Promise<{ metafile: Metafile; files: string[] }> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const result = await build({
    ...options,
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: [join(GALLERY, 'main.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    metafile: true,
    outfile: join(outDir, 'gallery.js'),
    logLevel: 'warning',
  })
  await buildStylesheet({ outFile: join(outDir, 'gallery.css'), sources })
  copyFileSync(join(GALLERY, 'index.html'), join(outDir, 'index.html'))
  return { metafile: result.metafile, files: readdirSync(outDir) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? GALLERY_REACT_OUT
  await buildGalleryReact(out)
  console.log(`react gallery built into ${out}`)
}
