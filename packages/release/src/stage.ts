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
  /** The bundled client CLI, shipped as `cli/vibase.js` of `@vibase/cli`. */
  cliJs: string
  /** The bundled `vibase-server` program, shipped as `cli/server.js` of `@vibase/server-d1` ([[OPS240]] D21). */
  serverJs: string
  /** The built Worker entry, copied to `worker/worker.js` (the source map and README of wrangler's outdir are not shipped). */
  workerEntry: string
  /** The built `connect/` directory, copied to `assets/connect/`. */
  assetsConnectDir: string
  migrationsDir: string
  /** The control-plane database's compiled migrations ([[CORE259]] D4), shipped as `control-migrations/` ([[OPS260]] D14). */
  controlMigrationsDir: string
  baseConfigText: string
  license: string
  clientReadme: string
  serverReadme: string
  migrations: readonly { name: string; sha256: string }[]
  controlMigrations: readonly { name: string; sha256: string }[]
}

/** The wrangler version `@vibase/server-d1` pins, read from its `package.json` so it is never typed twice ([[OPS210]] D6). */
export function readWranglerVersion(serverD1PackageJson: string): string {
  const v = (JSON.parse(readFileSync(serverD1PackageJson, 'utf8')) as { devDependencies?: Record<string, string> }).devDependencies?.wrangler
  if (v === undefined || !/^\d+\.\d+\.\d+$/.test(v)) throw new ReleaseRefusal(`${serverD1PackageJson} must pin wrangler to an exact version, found ${v === undefined ? 'none' : v}`)
  return v
}

const ENGINES = { node: '>=22' }
const PUBLISH_CONFIG = { access: 'public' }

/** The published `package.json` of `@vibase/cli` ([[OPS210]] D3, D22): the client, with no dependencies of any kind. */
export function clientPackageJson(version: string): Record<string, unknown> {
  return {
    name: '@vibase/cli',
    version,
    description: 'The vibase command line: every operation of a vibase instance as a command.',
    license: 'AGPL-3.0-only',
    type: 'module',
    bin: { vibase: 'cli/vibase.js' },
    engines: ENGINES,
    publishConfig: PUBLISH_CONFIG,
  }
}

/** The stable paths of the server package ([[OPS210]] D23 (a)): a change to one is a breaking change. */
export const SERVER_EXPORTS: Record<string, string> = {
  './worker': './worker/worker.js',
  './wrangler.base.jsonc': './wrangler.base.jsonc',
  './release.json': './release.json',
  './migrations/*': './migrations/*',
  './control-migrations/*': './control-migrations/*',
  './assets/*': './assets/*',
  './package.json': './package.json',
}

/** The published `package.json` of `@vibase/server-d1` ([[OPS210]] D3, D6, D22, D23 (a)): the prebuilt Worker and the `vibase-server` bin, wrangler pinned. */
export function serverPackageJson(version: string, wrangler: string): Record<string, unknown> {
  return {
    name: '@vibase/server-d1',
    version,
    description: 'A prebuilt vibase Worker for Cloudflare D1, its migrations and connect page, and vibase-server: setup, status and upgrade of an instance.',
    license: 'AGPL-3.0-only',
    type: 'module',
    bin: { 'vibase-server': 'cli/server.js' },
    engines: ENGINES,
    publishConfig: PUBLISH_CONFIG,
    dependencies: { wrangler },
    exports: SERVER_EXPORTS,
  }
}

/** The top level of the source `wrangler.jsonc` (no `env` blocks), with the three paths a build or a deploy relocates. */
export function deriveBaseConfig(sourceText: string, paths: { main: string; assetsDirectory: string; migrationsDir: string; controlMigrationsDir: string }): Record<string, unknown> {
  const { env: _env, ...top } = parse(sourceText) as Record<string, any>
  return {
    ...top,
    main: paths.main,
    assets: { ...top.assets, directory: paths.assetsDirectory },
    d1_databases: (top.d1_databases ?? []).map((d: Record<string, unknown>) => ({ ...d, migrations_dir: d.binding === 'CONTROL_DB' ? paths.controlMigrationsDir : paths.migrationsDir })),
  }
}

const copyInto = (dest: string, src: string) => {
  mkdirSync(join(dest, '..'), { recursive: true })
  copyFileSync(src, dest)
}

/** `@vibase/cli`: the client bundle, `package.json`, `LICENSE` and `README.md`, and nothing else ([[OPS210]] D3). No `release.json`: it deploys nothing. */
export function stageClient(i: StageInput): void {
  const out = i.outDir
  copyInto(join(out, 'cli', 'vibase.js'), i.cliJs)
  writeFileSync(join(out, 'LICENSE'), i.license)
  writeFileSync(join(out, 'README.md'), i.clientReadme)
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(clientPackageJson(i.version), null, 2)}\n`)
}

/** `@vibase/server-d1`: the `vibase-server` program, the Worker, the connect assets, the migrations (CRM and control plane), the base config and `release.json` ([[OPS210]] D3, D4). */
export function stageServer(i: StageInput): ReleaseManifest {
  const out = i.outDir
  copyInto(join(out, 'cli', 'server.js'), i.serverJs)
  copyInto(join(out, 'worker', 'worker.js'), i.workerEntry)
  for (const f of readdirSync(i.assetsConnectDir)) copyInto(join(out, 'assets', 'connect', f), join(i.assetsConnectDir, f))
  for (const f of readdirSync(i.migrationsDir).filter((n) => n.endsWith('.sql'))) copyInto(join(out, 'migrations', f), join(i.migrationsDir, f))
  for (const f of readdirSync(i.controlMigrationsDir).filter((n) => n.endsWith('.sql'))) copyInto(join(out, 'control-migrations', f), join(i.controlMigrationsDir, f))
  const base = deriveBaseConfig(i.baseConfigText, { main: 'worker/worker.js', assetsDirectory: 'assets', migrationsDir: 'migrations', controlMigrationsDir: 'control-migrations' })
  writeFileSync(join(out, 'wrangler.base.jsonc'), `// The base Worker config of a vibase release: no instance in it. An instance deploy generates its own config from this one and the instance settings.\n${JSON.stringify(base, null, 2)}\n`)
  writeFileSync(join(out, 'LICENSE'), i.license)
  writeFileSync(join(out, 'README.md'), i.serverReadme)
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(serverPackageJson(i.version, i.wranglerVersion), null, 2)}\n`)
  const manifest = buildReleaseManifest({ name: '@vibase/server-d1', dir: out, version: i.version, commit: i.commit, builtAt: i.builtAt, wrangler: i.wranglerVersion, compatibilityDate: i.compatibilityDate, node: i.node, migrations: i.migrations, controlMigrations: i.controlMigrations })
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
