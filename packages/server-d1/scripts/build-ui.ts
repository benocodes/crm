// Builds the auth pages ([[UI246]] D2) into the directory `wrangler.jsonc` names as `assets.directory`, beside the connect page:
//   pnpm -C packages/server-d1 build
// One Preact bundle for every page (`src/ui/main.tsx` picks the view from the path), bundled by esbuild with @vibase/ui's options ([[UI254]] D1, D4: the React names alias to Preact, resolved from this
// package, which depends on `preact` itself); `index.html` is copied and `ui.css` is @vibase/ui's stylesheet, unchanged. Every file goes under `ui/` so its asset path is its request path
// (`/ui/app.js`). The output is gitignored (`dist/`). Nothing built here reaches the Worker bundle.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esbuildOptions, stylesheetPath } from '@vibase/ui/esbuild'
import { build } from 'esbuild'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(PKG, 'src', 'ui')
export const UI_DIR_NAME = 'ui'

/** Builds into `<outDir>/ui/` and returns esbuild's metafile (the inputs the bundle holds; the build test reads it). */
export async function buildUi(outDir: string): Promise<{ inputs: Record<string, unknown> }> {
  const dir = join(outDir, UI_DIR_NAME)
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
    outfile: join(dir, 'app.js'),
    logLevel: 'warning',
  })
  copyFileSync(join(SRC, 'index.html'), join(dir, 'index.html'))
  copyFileSync(stylesheetPath, join(dir, 'ui.css'))
  return result.metafile
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../dist/assets', import.meta.url))
  await buildUi(out)
  console.log(`auth pages built into ${out}/${UI_DIR_NAME}`)
}
