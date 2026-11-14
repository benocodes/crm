// Builds the test-only gallery ([[UI254]] D7) into `outDir` with the exported esbuild options, the way a page build does:
//   pnpm -C packages/ui exec tsx scripts/build-gallery.ts [outDir]
// The gallery lives outside `src` and outside every export, so no page build can pick it up; its output goes to the gitignored `dist/`.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type BuildOptions, type Metafile } from 'esbuild'
import { esbuildOptions } from '../src/esbuild-options'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const GALLERY = fileURLToPath(new URL('../gallery/', import.meta.url))
const STYLESHEET = fileURLToPath(new URL('../src/ui.css', import.meta.url))
export const GALLERY_OUT = fileURLToPath(new URL('../dist/gallery', import.meta.url))

export async function buildGallery(
  outDir: string = GALLERY_OUT,
  options: BuildOptions = esbuildOptions as unknown as BuildOptions,
): Promise<{ metafile: Metafile; files: string[] }> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const result = await build({
    ...options,
    // esbuild resolves an alias target from the working directory, so this build runs from the package that depends on `preact`.
    absWorkingDir: PACKAGE,
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
  copyFileSync(join(GALLERY, 'index.html'), join(outDir, 'index.html'))
  copyFileSync(STYLESHEET, join(outDir, 'gallery.css'))
  return { metafile: result.metafile, files: readdirSync(outDir) }
}

/** The npm packages whose files are in the bundle (the innermost `node_modules/<name>` of each input). */
export function packagesIn(metafile: Metafile): string[] {
  const names = new Set<string>()
  for (const input of Object.keys(metafile.inputs)) {
    const all = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)]
    const last = all.at(-1)
    if (last) names.add(last[1]!)
  }
  return [...names].sort()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? GALLERY_OUT
  await buildGallery(out)
  console.log(`gallery built into ${out}`)
}
