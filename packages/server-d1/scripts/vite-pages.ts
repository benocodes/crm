// The one Vite config factory for the page bundles ([[UI489]] D1, D2, D4): `buildPage` (the builds) and `devConfig` (the dev server) read it, so build and dev share the root, the plugins and the layout.
// No `vite.config.*` at the package root (vitest, Biome and editors would discover it); every caller passes `configFile: false`.
// Vite's root is `src/` and the base `/assets/` ([[UI504]] D3, D9), so a page's source `/app/main.tsx` is the URL `/assets/app/main.tsx` in dev and the built `<outDir>/assets/app/app.js` is `/assets/app/app.js`, the file the Worker serves.
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { build, type InlineConfig, type PluginOption, type Rolldown } from 'vite'
import { ASSET_PREFIX, APP_BUNDLE, UI_BUNDLE } from '../src/app/paths.js'

export const PKG = fileURLToPath(new URL('..', import.meta.url))
export const SRC = join(PKG, 'src')

export interface PageSpec {
  /** The directory under `src/` and under the assets directory (`/<dir>/<file>` is the asset path). */
  dir: typeof APP_BUNDLE | typeof UI_BUNDLE
  /** The built script's file name: today's, kept ([[UI489]] D2). */
  js: string
  /** The built stylesheet's file name. */
  css: string
}
export const APP_PAGE: PageSpec = { dir: APP_BUNDLE, js: 'app.js', css: 'app.css' }
export const UI_PAGE: PageSpec = { dir: UI_BUNDLE, js: 'app.js', css: 'ui.css' }

/** The plugins both builds and the dev server run: React (automatic runtime, Fast Refresh in dev) and Tailwind. */
const plugins = () => [react(), tailwindcss()]

/** The Vite config of a page build: one `index.html` input, one script and one stylesheet at fixed names, no hash, chunk, modulepreload polyfill or source map (D2). */
export function pageBuildConfig(page: PageSpec, outDir: string): InlineConfig {
  return {
    configFile: false,
    root: SRC,
    // The URL of a built file is the base plus its path under Vite's outDir: the outDir is `<assets directory>/assets`, so `app/app.js` is `/assets/app/app.js`.
    base: `${ASSET_PREFIX}/`,
    publicDir: false,
    logLevel: 'warn',
    plugins: plugins(),
    build: {
      outDir: join(outDir, ASSET_PREFIX),
      // The directory holds the other page too: the caller clears this page's folder, Vite never empties the assets directory.
      emptyOutDir: false,
      modulePreload: false,
      cssCodeSplit: false,
      sourcemap: false,
      reportCompressedSize: false,
      rolldownOptions: {
        input: join(SRC, page.dir, 'index.html'),
        output: {
          entryFileNames: `${page.dir}/${page.js}`,
          chunkFileNames: `${page.dir}/[name].js`,
          assetFileNames: (asset) =>
            asset.names.some((n) => n.endsWith('.css')) ? `${page.dir}/${page.css}` : `${page.dir}/[name][extname]`,
        },
      },
    },
  }
}

/** The dev server's config: the same root, base and plugins; Vite's own HTML handling is off (`custom`), the dev server serves each page's `index.html` itself. */
export function devConfig(opts: { port: number; plugins?: PluginOption[] }): InlineConfig {
  return {
    configFile: false,
    root: SRC,
    base: `${ASSET_PREFIX}/`,
    publicDir: false,
    appType: 'custom',
    plugins: [...(opts.plugins ?? []), ...plugins()],
    server: { host: 'localhost', port: opts.port, strictPort: opts.port !== 0 },
    optimizeDeps: { entries: [join(SRC, 'app', 'index.html'), join(SRC, 'ui', 'index.html')] },
  }
}

/**
 * Builds one page into `<outDir>/assets/<dir>/` and returns the module ids of its bundle (the build tests read them: which packages and files went in).
 * [[UI504]] P3: first it removes everything in `outDir` outside `assets/` (the old `ui/` and `app/` layout, a stale `connect/`), so the binding directory holds no file outside `assets/<bundle>/`
 * (a stale `ui/app.js` would be served by the binding at `/ui/app.js`, `/ui/*` no longer going to the Worker first), and this bundle's own folder.
 */
export async function buildPage(page: PageSpec, outDir: string): Promise<string[]> {
  const keep = ASSET_PREFIX.slice(1)
  const entries = existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }) : []
  for (const entry of entries.filter((e) => e.name !== keep || !e.isDirectory()))
    rmSync(join(outDir, entry.name), { recursive: true, force: true })
  rmSync(join(outDir, ASSET_PREFIX, page.dir), { recursive: true, force: true })
  // Vite and the React plugin take production from `process.env.NODE_ENV` when it is set (under vitest it is `test`, which would ship React's development build): a page build is always production.
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let result: Awaited<ReturnType<typeof build>>
  try {
    result = await build(pageBuildConfig(page, outDir))
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
  return outputs.flatMap((o) => o.output.flatMap((c) => (c.type === 'chunk' ? c.moduleIds : [])))
}
