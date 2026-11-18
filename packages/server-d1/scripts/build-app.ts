// Builds the workspace app ([[UI460]] D6, [[UI443]]) into the directory `wrangler.jsonc` names as `assets.directory`, beside the connect page and the auth pages:
//   pnpm -C packages/server-d1 build
// One React bundle (`src/app/main.tsx`), bundled by esbuild with `@vibase/ui/build`'s React options; `index.html` is copied and `app.css` is the Tailwind build over `@vibase/ui`'s components and this package's `src/app`.
// Every file goes under `app/` so its asset path is its request path (`/app/app.js`). The output is gitignored (`dist/`). Nothing built here reaches the Worker bundle.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStylesheet, reactBuildOptions } from '@vibase/ui/build'
import { build } from 'esbuild'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(PKG, 'src', 'app')
export const APP_DIR_NAME = 'app'

/** Builds into `<outDir>/app/` and returns esbuild's metafile (the inputs the bundle holds; the build test reads it). */
export async function buildApp(outDir: string): Promise<{ inputs: Record<string, unknown> }> {
  const dir = join(outDir, APP_DIR_NAME)
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
  await buildStylesheet({ outFile: join(dir, 'app.css'), sources: [SRC] })
  return result.metafile
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../dist/assets', import.meta.url))
  await buildApp(out)
  console.log(`workspace app built into ${out}/${APP_DIR_NAME}`)
}
