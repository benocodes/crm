// Builds the workspace app ([[UI460]] D6, [[UI443]], [[UI489]]) into the directory `wrangler.jsonc` names as `assets.directory`, beside the auth pages:
//   pnpm -C packages/server-d1 build
// One React bundle (`src/app/main.tsx`, named by `src/app/index.html`), built by Vite (`vite-pages.ts`); the stylesheet is the Tailwind build of `src/app/styles.css` over `@vibase/ui`'s components and this package's `src/app`.
// Every file goes under `assets/app/` of the output directory so its asset path is its request path (`/assets/app/…`, UI504 D3). The output is gitignored (`dist/`). Nothing built here reaches the Worker bundle.
import { fileURLToPath } from 'node:url'
import { APP_PAGE, buildPage } from './vite-pages.js'

export const APP_DIR_NAME = APP_PAGE.dir

/** Builds into `<outDir>/assets/app/` (and clears the old layout, UI504 P3) and returns the bundle's module ids (the build test reads them). */
export const buildApp = (outDir: string): Promise<string[]> => buildPage(APP_PAGE, outDir)

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../dist/assets', import.meta.url))
  await buildApp(out)
  console.log(`workspace app built into ${out}/assets/${APP_DIR_NAME}`)
}
