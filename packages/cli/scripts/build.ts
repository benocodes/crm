// The CLI build ([[OPS210]] D1): one esbuild bundle whose `--version` is the release package's version, the only version source.
//   pnpm -C packages/cli build
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const RELEASE_PACKAGE_JSON = fileURLToPath(new URL('../../release/package.json', import.meta.url))
const ENTRY = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const OUTFILE = fileURLToPath(new URL('../dist/vibase.js', import.meta.url))

export async function buildCli(opts: { outfile?: string; releasePackageJson?: string } = {}): Promise<void> {
  const version = (JSON.parse(readFileSync(opts.releasePackageJson ?? RELEASE_PACKAGE_JSON, 'utf8')) as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') throw new Error(`${opts.releasePackageJson ?? RELEASE_PACKAGE_JSON} has no version`)
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: opts.outfile ?? OUTFILE,
    banner: { js: '#!/usr/bin/env node' },
    define: { __VIBASE_VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildCli()
