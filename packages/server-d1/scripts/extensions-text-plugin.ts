// An esbuild plugin for the scripts that bundle `src/worker.ts` themselves ([[CORE543]] P7). A deploy attaches `vibase-extensions.json` as a Text module (a `rules` entry in the config); esbuild would parse the file as JSON, so the one
// file of that name is inlined as text: the checked-in empty default, which is what a repo build serves.
import { readFileSync } from 'node:fs'
import type { Plugin } from 'esbuild'

export const extensionsTextModule: Plugin = {
  name: 'extensions-text-module',
  setup: (b) => {
    b.onLoad({ filter: /[\\/]vibase-extensions\.json$/ }, (a) => ({
      contents: readFileSync(a.path, 'utf8'),
      loader: 'text',
    }))
  },
}
