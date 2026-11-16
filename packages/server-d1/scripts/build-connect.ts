// Builds the connect page ([[UI30]] D3) into the directory `wrangler.jsonc` names as `assets.directory`:
//   pnpm -C packages/server-d1 build
// Preact components on `@vibase/ui` ([[UI254]] D9, [[UI256]]), bundled by esbuild with @vibase/ui's options into one script; `index.html`, `ui.css` (@vibase/ui's, unchanged) and the page stylesheet are copied. Every file goes under `connect/`
// so its asset path is its request path (`/connect/connect.js`), and nothing is reachable at any other path. The output is gitignored (`dist/`).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esbuildOptions, stylesheetPath } from '@vibase/ui/esbuild'
import { build } from 'esbuild'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const SRC = fileURLToPath(new URL('../src/connect/', import.meta.url))
/** The directory `wrangler.jsonc`'s `assets.directory` names. */
export const ASSETS_DIR = fileURLToPath(new URL('../dist/assets', import.meta.url))

/** Builds into `<outDir>/connect/` and returns esbuild's metafile (the inputs the bundle holds; the build test reads it). */
export async function buildConnect(outDir: string = ASSETS_DIR): Promise<{ inputs: Record<string, unknown> }> {
  const dir = join(outDir, 'connect')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const result = await build({
    ...esbuildOptions,
    absWorkingDir: PKG,
    entryPoints: [join(SRC, 'main.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    metafile: true,
    outfile: join(dir, 'connect.js'),
    logLevel: 'warning',
  })
  copyFileSync(join(SRC, 'index.html'), join(dir, 'index.html'))
  copyFileSync(stylesheetPath, join(dir, 'ui.css'))
  copyFileSync(join(SRC, 'connect-page.css'), join(dir, 'connect-page.css'))
  return result.metafile
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildConnect()
  console.log(`connect page built into ${ASSETS_DIR}/connect`)
}
