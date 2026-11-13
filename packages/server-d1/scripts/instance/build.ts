// The bundle `cli/instance.js` of a release package ([[OPS231]] D12): the `vibase instance` commands, one esbuild file the client CLI loads from beside itself.
// It bundles the release verification and `remote.ts`'s tracker helpers; the package's own wrangler is resolved at run time, never bundled.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url))
const OUTFILE = fileURLToPath(new URL('../../dist/instance.js', import.meta.url))

export async function buildInstance(opts: { outfile?: string } = {}): Promise<void> {
  await build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: opts.outfile ?? OUTFILE,
    // jsonc-parser's default entry is UMD, whose bundled form calls a dynamic `require`: take its ESM entry.
    mainFields: ['module', 'main'],
    logLevel: 'warning',
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildInstance()
