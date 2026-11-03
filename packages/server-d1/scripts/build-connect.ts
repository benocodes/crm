// Builds the connect page ([[UI30]] D3) into the directory `wrangler.jsonc` names as `assets.directory`:
//   pnpm -C packages/server-d1 build
// Hand-written TypeScript, bundled by esbuild into one script; `index.html` and the stylesheet are copied. Every file goes under `connect/`
// so its asset path is its request path (`/connect/connect.js`), and nothing is reachable at any other path. The output is gitignored (`dist/`).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const SRC = fileURLToPath(new URL('../src/connect/', import.meta.url))
/** The directory `wrangler.jsonc`'s `assets.directory` names. */
export const ASSETS_DIR = fileURLToPath(new URL('../dist/assets', import.meta.url))

export async function buildConnect(outDir: string = ASSETS_DIR): Promise<void> {
  const dir = join(outDir, 'connect')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await build({
    entryPoints: [join(SRC, 'main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    outfile: join(dir, 'connect.js'),
    logLevel: 'warning',
  })
  copyFileSync(join(SRC, 'index.html'), join(dir, 'index.html'))
  copyFileSync(join(SRC, 'connect.css'), join(dir, 'connect.css'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildConnect()
  console.log(`connect page built into ${ASSETS_DIR}/connect`)
}
