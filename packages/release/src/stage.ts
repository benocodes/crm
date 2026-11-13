// The staged package directory: the cycle-1 layout of [[OPS210]] D3, with its `package.json` and `release.json`.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { ReleaseRefusal } from './errors.js'
import { buildReleaseManifest, type ReleaseManifest } from './manifest.js'

export interface StageInput {
  outDir: string
  version: string
  commit: string
  builtAt: string
  wranglerVersion: string
  compatibilityDate: string
  node: string
  /** The bundled client CLI. */
  cliJs: string
  /** The built Worker entry, copied to `worker/worker.js` (the source map and README of wrangler's outdir are not shipped). */
  workerEntry: string
  /** The built `connect/` directory, copied to `assets/connect/`. */
  assetsConnectDir: string
  migrationsDir: string
  baseConfigText: string
  license: string
  readme: string
  migrations: readonly { name: string; sha256: string }[]
}

/** The wrangler version `@vault/server-d1` pins, read from its `package.json` so it is never typed twice ([[OPS210]] D6). */
export function readWranglerVersion(serverD1PackageJson: string): string {
  const v = (JSON.parse(readFileSync(serverD1PackageJson, 'utf8')) as { devDependencies?: Record<string, string> }).devDependencies?.wrangler
  if (v === undefined || !/^\d+\.\d+\.\d+$/.test(v)) throw new ReleaseRefusal(`${serverD1PackageJson} must pin wrangler to an exact version, found ${v === undefined ? 'none' : v}`)
  return v
}

export function publishedPackageJson(version: string, wrangler: string): Record<string, unknown> {
  return {
    name: 'vibase',
    version,
    description: 'The vibase CLI and a prebuilt vault Worker: one released version of the whole product.',
    license: 'AGPL-3.0-only',
    type: 'module',
    bin: { vibase: 'cli/vibase.js' },
    engines: { node: '>=22' },
    dependencies: { wrangler },
  }
}

/** The top level of the source `wrangler.jsonc` (no `env` blocks), with the three paths a build or a deploy relocates. */
export function deriveBaseConfig(sourceText: string, paths: { main: string; assetsDirectory: string; migrationsDir: string }): Record<string, unknown> {
  const { env: _env, ...top } = parse(sourceText) as Record<string, any>
  return {
    ...top,
    main: paths.main,
    assets: { ...top.assets, directory: paths.assetsDirectory },
    d1_databases: (top.d1_databases ?? []).map((d: Record<string, unknown>) => ({ ...d, migrations_dir: paths.migrationsDir })),
  }
}

const copyInto = (dest: string, src: string) => {
  mkdirSync(join(dest, '..'), { recursive: true })
  copyFileSync(src, dest)
}

export function stageRelease(i: StageInput): ReleaseManifest {
  const out = i.outDir
  copyInto(join(out, 'cli', 'vibase.js'), i.cliJs)
  copyInto(join(out, 'worker', 'worker.js'), i.workerEntry)
  for (const f of readdirSync(i.assetsConnectDir)) copyInto(join(out, 'assets', 'connect', f), join(i.assetsConnectDir, f))
  for (const f of readdirSync(i.migrationsDir).filter((n) => n.endsWith('.sql'))) copyInto(join(out, 'migrations', f), join(i.migrationsDir, f))
  const base = deriveBaseConfig(i.baseConfigText, { main: 'worker/worker.js', assetsDirectory: 'assets', migrationsDir: 'migrations' })
  writeFileSync(join(out, 'wrangler.base.jsonc'), `// The base Worker config of a vibase release: no instance in it. An instance deploy generates its own config from this one and the instance settings.\n${JSON.stringify(base, null, 2)}\n`)
  writeFileSync(join(out, 'LICENSE'), i.license)
  writeFileSync(join(out, 'README.md'), i.readme)
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(publishedPackageJson(i.version, i.wranglerVersion), null, 2)}\n`)
  const manifest = buildReleaseManifest({ dir: out, version: i.version, commit: i.commit, builtAt: i.builtAt, wrangler: i.wranglerVersion, compatibilityDate: i.compatibilityDate, node: i.node, migrations: i.migrations })
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
