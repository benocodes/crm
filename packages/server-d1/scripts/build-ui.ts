// Builds the auth pages ([[UI246]] D2, [[UI489]]) into the directory `wrangler.jsonc` names as `assets.directory`, beside the workspace app:
//   pnpm -C packages/server-d1 build
// One React bundle for every page (`src/ui/main.tsx` picks the view from the path, named by `src/ui/index.html`), built by Vite (`vite-pages.ts`); the stylesheet is the Tailwind build of `src/ui/styles.css` over `@vibase/ui`'s
// components and this package's `src/ui`. Every file goes under `ui/` so its asset path is its request path (`/ui/app.js`). The output is gitignored (`dist/`). Nothing built here reaches the Worker bundle.
import { fileURLToPath } from 'node:url'
import { buildPage, UI_PAGE } from './vite-pages.js'

export const UI_DIR_NAME = UI_PAGE.dir

/** Builds into `<outDir>/ui/` and returns the bundle's module ids (the build test reads them). */
export const buildUi = (outDir: string): Promise<string[]> => buildPage(UI_PAGE, outDir)

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../dist/assets', import.meta.url))
  await buildUi(out)
  console.log(`auth pages built into ${out}/${UI_DIR_NAME}`)
}
