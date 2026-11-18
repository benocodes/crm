// Builds the auth pages ([[UI246]] D2) into the directory `wrangler.jsonc` names as `assets.directory`, beside the connect page:
//   pnpm -C packages/server-d1 build
// One React bundle for every page (`src/ui/main.tsx` picks the view from the path), bundled by esbuild with `@vibase/ui/build`'s React options ([[UI446]] D4, [[UI445]] D8); `index.html` is copied
// and `ui.css` is the Tailwind build over `@vibase/ui`'s components and this package's `src/ui`. Every file goes under `ui/` so its asset path is its request path (`/ui/app.js`). The output is gitignored (`dist/`). Nothing built here reaches the Worker bundle.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStylesheet, reactBuildOptions } from '@vibase/ui/build'
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
    ...reactBuildOptions,
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
  await buildStylesheet({ outFile: join(dir, 'ui.css'), sources: [SRC] })
  return result.metafile
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../dist/assets', import.meta.url))
  await buildUi(out)
  console.log(`auth pages built into ${out}/${UI_DIR_NAME}`)
}
