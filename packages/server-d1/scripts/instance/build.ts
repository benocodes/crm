// The bundle `cli/server.js` of the server package ([[OPS231]] D12, [[OPS240]] D21): the `vibase-server` program, one esbuild file that is the package bin.
// It bundles the release verification and `remote.ts`'s tracker helpers; the package's own wrangler is resolved at run time, never bundled.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('./bin.ts', import.meta.url))
const OUTFILE = fileURLToPath(new URL('../../dist/server.js', import.meta.url))

export async function buildInstance(opts: { outfile?: string } = {}): Promise<void> {
  await build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: opts.outfile ?? OUTFILE,
    banner: { js: '#!/usr/bin/env node' },
    // jsonc-parser's default entry is UMD, whose bundled form calls a dynamic `require`: take its ESM entry.
    mainFields: ['module', 'main'],
    logLevel: 'warning',
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildInstance()
