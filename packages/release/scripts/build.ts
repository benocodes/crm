// `pnpm release:build [--allow-dirty]` ([[OPS210]] D3-D6): builds `packages/release/dist/vibase-<version>.tgz`. Nothing is published, nothing leaves the machine.
// The Worker is built by `wrangler deploy --dry-run --outdir` against a config derived from `packages/server-d1/wrangler.jsonc`'s top level (no `env`
// blocks, so no instance id) and run with a minimal environment: no Cloudflare credential, no `.env` is read.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'
import { MIGRATIONS } from '@vault/storage-d1'
import { buildCli } from '../../cli/scripts/build.js'
import { buildConnect } from '../../server-d1/scripts/build-connect.js'
import { buildInstance } from '../../server-d1/scripts/instance/build.js'
import { envDatabaseIds, assertNoForbidden } from '../src/forbidden.js'
import { releaseCommit } from '../src/git.js'
import { assertRelease } from '../src/manifest.js'
import { deriveBaseConfig, readWranglerVersion, stageRelease } from '../src/stage.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(PKG, '..', '..')
const SERVER_D1 = join(REPO, 'packages', 'server-d1')
export const DIST = join(PKG, 'dist')

/** A minimal environment for wrangler's offline dry run: no Cloudflare credential, no repo variable. */
export const wranglerEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', WRANGLER_SEND_METRICS: 'false' })

export async function buildRelease(opts: { allowDirty?: boolean } = {}): Promise<{ tarball: string; version: string; commit: string }> {
  const version = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version
  const commit = releaseCommit({ cwd: REPO, allowDirty: opts.allowDirty })
  const wranglerVersion = readWranglerVersion(join(SERVER_D1, 'package.json'))
  const sourceConfig = readFileSync(join(SERVER_D1, 'wrangler.jsonc'), 'utf8')
  const work = mkdtempSync(join(tmpdir(), 'vibase-release-'))
  try {
    const cliJs = join(work, 'cli', 'vibase.js')
    await buildCli({ outfile: cliJs })
    const instanceJs = join(work, 'cli', 'instance.js')
    await buildInstance({ outfile: instanceJs })
    const assets = join(work, 'assets')
    await buildConnect(assets)
    const migrationsDir = join(REPO, 'packages', 'storage-d1', 'migrations')
    const buildConfig = join(work, 'wrangler.build.jsonc')
    writeFileSync(buildConfig, JSON.stringify(deriveBaseConfig(sourceConfig, { main: join(SERVER_D1, 'src', 'worker.ts'), assetsDirectory: assets, migrationsDir })))
    const wrangler = join(SERVER_D1, 'node_modules', '.bin', 'wrangler')
    execFileSync(wrangler, ['deploy', '--dry-run', '--outdir', join(work, 'wout'), '-c', buildConfig], { cwd: work, env: wranglerEnv(), stdio: ['ignore', 'ignore', 'inherit'] })
    const stage = join(work, 'package')
    mkdirSync(stage)
    stageRelease({
      outDir: stage,
      version,
      commit,
      builtAt: new Date().toISOString(),
      wranglerVersion,
      compatibilityDate: (parse(sourceConfig) as { compatibility_date: string }).compatibility_date,
      node: '>=22',
      cliJs,
      instanceJs,
      workerEntry: join(work, 'wout', 'worker.js'),
      assetsConnectDir: join(assets, 'connect'),
      migrationsDir,
      baseConfigText: sourceConfig,
      license: readFileSync(join(REPO, 'LICENSE'), 'utf8'),
      readme: readFileSync(join(PKG, 'README.md'), 'utf8'),
      migrations: MIGRATIONS,
    })
    assertNoForbidden(stage, { databaseIds: envDatabaseIds(sourceConfig) })
    assertRelease(stage)
    mkdirSync(DIST, { recursive: true })
    for (const f of readdirSync(DIST)) if (f.endsWith('.tgz')) rmSync(join(DIST, f))
    execFileSync('npm', ['pack', '--pack-destination', DIST, '--ignore-scripts', '--silent'], { cwd: stage, stdio: ['ignore', 'ignore', 'inherit'] })
    const tarball = join(DIST, `vibase-${version}.tgz`)
    if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`)
    return { tarball, version, commit }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { tarball, version, commit } = await buildRelease({ allowDirty: process.argv.includes('--allow-dirty') })
  console.log(`built ${tarball}\nversion ${version}, commit ${commit}`)
}
