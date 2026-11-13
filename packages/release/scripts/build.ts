// `pnpm release:build [--allow-dirty]` ([[OPS210]] D2-D6, [[OPS240]]): builds `packages/release/dist/vibase-cli-<version>.tgz` (`@vibase/cli`), `vibase-server-d1-<version>.tgz`
// (`@vibase/server-d1`) and one `SHA256SUMS`. Nothing is published, nothing leaves the machine.
// The Worker is built by `wrangler deploy --dry-run --outdir` against a config derived from `packages/server-d1/wrangler.jsonc`'s top level (no `env`
// blocks, so no instance id) and run with a minimal environment: no Cloudflare credential, no `.env` is read.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'
import { CONTROL_MIGRATIONS, MIGRATIONS } from '@vibase/storage-d1'
import { buildCli } from '../../cli/scripts/build.js'
import { buildConnect } from '../../server-d1/scripts/build-connect.js'
import { buildInstance } from '../../server-d1/scripts/instance/build.js'
import { envDatabaseIds, assertNoForbidden } from '../src/forbidden.js'
import { releaseCommit } from '../src/git.js'
import { assertClientLayout, assertCommit, assertServerLayout } from '../src/layout.js'
import { assertRelease } from '../src/manifest.js'
import { readReleaseVersion } from '../src/version.js'
import { packRelease } from '../src/pack.js'
import { deriveBaseConfig, readWranglerVersion, stageClient, stageServer } from '../src/stage.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(PKG, '..', '..')
const SERVER_D1 = join(REPO, 'packages', 'server-d1')
export const DIST = join(PKG, 'dist')

/** A minimal environment for wrangler's offline dry run: no Cloudflare credential, no repo variable. */
export const wranglerEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', WRANGLER_SEND_METRICS: 'false' })

export async function buildRelease(opts: { allowDirty?: boolean } = {}): Promise<{ client: string; server: string; sums: string; version: string; commit: string }> {
  const version = readReleaseVersion(REPO)
  const commit = releaseCommit({ cwd: REPO, allowDirty: opts.allowDirty })
  const wranglerVersion = readWranglerVersion(join(SERVER_D1, 'package.json'))
  const sourceConfig = readFileSync(join(SERVER_D1, 'wrangler.jsonc'), 'utf8')
  const work = mkdtempSync(join(tmpdir(), 'vibase-release-'))
  try {
    const cliJs = join(work, 'cli', 'vibase.js')
    await buildCli({ outfile: cliJs, version })
    const serverJs = join(work, 'cli', 'server.js')
    await buildInstance({ outfile: serverJs })
    const assets = join(work, 'assets')
    await buildConnect(assets)
    const migrationsDir = join(REPO, 'packages', 'storage-d1', 'migrations')
    const controlMigrationsDir = join(REPO, 'packages', 'storage-d1', 'control-migrations')
    const buildConfig = join(work, 'wrangler.build.jsonc')
    writeFileSync(buildConfig, JSON.stringify(deriveBaseConfig(sourceConfig, { main: join(SERVER_D1, 'src', 'worker.ts'), assetsDirectory: assets, migrationsDir, controlMigrationsDir })))
    const wrangler = join(SERVER_D1, 'node_modules', '.bin', 'wrangler')
    execFileSync(wrangler, ['deploy', '--dry-run', '--outdir', join(work, 'wout'), '-c', buildConfig], { cwd: work, env: wranglerEnv(), stdio: ['ignore', 'ignore', 'inherit'] })
    const common = {
      version,
      commit,
      builtAt: new Date().toISOString(),
      wranglerVersion,
      compatibilityDate: (parse(sourceConfig) as { compatibility_date: string }).compatibility_date,
      node: '>=22',
      cliJs,
      serverJs,
      workerEntry: join(work, 'wout', 'worker.js'),
      assetsConnectDir: join(assets, 'connect'),
      migrationsDir,
      controlMigrationsDir,
      baseConfigText: sourceConfig,
      license: readFileSync(join(REPO, 'LICENSE'), 'utf8'),
      clientReadme: readFileSync(join(PKG, 'templates', 'cli-README.md'), 'utf8'),
      serverReadme: readFileSync(join(PKG, 'templates', 'server-d1-README.md'), 'utf8'),
      migrations: MIGRATIONS,
      controlMigrations: CONTROL_MIGRATIONS,
    }
    const clientDir = join(work, 'package-cli')
    const serverDir = join(work, 'package-server-d1')
    mkdirSync(clientDir)
    mkdirSync(serverDir)
    stageClient({ ...common, outDir: clientDir })
    const manifest = stageServer({ ...common, outDir: serverDir })
    const databaseIds = envDatabaseIds(sourceConfig)
    for (const dir of [clientDir, serverDir]) assertNoForbidden(dir, { databaseIds })
    assertClientLayout(clientDir, version)
    assertServerLayout(serverDir, version)
    assertCommit(manifest.commit)
    assertRelease(serverDir)
    return { ...packRelease({ clientDir, serverDir, dist: DIST, version }), version, commit }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { client, server, sums, version, commit } = await buildRelease({ allowDirty: process.argv.includes('--allow-dirty') })
  console.log(`built ${client}\nbuilt ${server}\nwrote ${sums}\nversion ${version}, commit ${commit}`)
}
