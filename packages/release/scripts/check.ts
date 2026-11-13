// `pnpm release:check [<tarball>]` ([[OPS210]] D8): proves the built package, not the source. The tarball defaults to
// `packages/release/dist/vibase-<release version>.tgz`. It extracts and verifies the tarball, refuses forbidden content, installs it with
// `npm install` into an empty temp directory outside the repo (the only network read: the public npm registry, for wrangler;
// `--prefer-offline`, never the repo's node_modules), runs the installed `vibase --version`, applies the installed migrations to a fresh
// local D1 with the installed wrangler, and runs the installed Worker and assets in workerd (Miniflare 4, the repo's test harness).
// Nothing is published; no Cloudflare call or credential is involved (the child processes get a minimal environment).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'
import { ReleaseRefusal } from '../src/errors.js'
import { assertNoForbidden, envDatabaseIds } from '../src/forbidden.js'
import { assertRelease, type ReleaseManifest } from '../src/manifest.js'
import { wranglerEnv } from './build.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(PKG, '..', '..')

/** The child environment of the npm install: the user's PATH and HOME, nothing the repo's pnpm run exported (npm_*, pnpm_*). */
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|pnpm_|NPM_|PNPM_|INIT_CWD|CLOUDFLARE_|CLERK_)/.test(k)))

const sh = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv()) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export interface CheckResult {
  installPath: string
  cliVersion: string
  wranglerVersion: string
  health: Record<string, unknown>
  connectStatus: number
}

export async function checkRelease(tarballArg: string, log: (line: string) => void = console.log): Promise<CheckResult> {
  const tarball = resolve(tarballArg)
  if (!existsSync(tarball)) throw new ReleaseRefusal(`no such tarball: ${tarball}`)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibase-check-')))
  const inRepo = relative(REPO, root)
  if (!inRepo.startsWith('..') && !isAbsolute(inRepo)) throw new ReleaseRefusal(`the check directory ${root} is inside the repo`)
  try {
    const databaseIds = envDatabaseIds(readFileSync(join(REPO, 'packages', 'server-d1', 'wrangler.jsonc'), 'utf8'))
    // 1. the tarball itself: extract, refuse forbidden content (first: it names a planted file by kind), then verify release.json against the files.
    const extract = join(root, 'extract')
    mkdirSync(extract)
    sh('tar', ['-xzf', tarball, '-C', extract], root)
    const pkgDir = join(extract, 'package')
    assertNoForbidden(pkgDir, { databaseIds })
    assertRelease(pkgDir)
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'release.json'), 'utf8')) as ReleaseManifest
    log(`tarball ok: ${manifest.name} ${manifest.version} @ ${manifest.commit}, ${Object.keys(manifest.files).length} files verified`)

    // 2. an empty directory outside the repo, npm install of the tarball.
    const install = join(root, 'install')
    mkdirSync(install)
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'vibase-check', private: true }))
    sh('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-progress', tarball], install)
    const installed = join(install, 'node_modules', 'vibase')
    assertNoForbidden(installed, { databaseIds })
    assertRelease(installed)
    log(`installed into ${install}`)

    // 3. the installed commands.
    const cliVersion = sh(join(install, 'node_modules', '.bin', 'vibase'), ['--version'], install).trim()
    if (cliVersion !== `vibase-cli/${manifest.version}`) throw new ReleaseRefusal(`the installed vibase prints ${cliVersion}, expected vibase-cli/${manifest.version}`)
    const wranglerBin = join(install, 'node_modules', '.bin', 'wrangler')
    const wranglerVersion = sh(wranglerBin, ['--version'], install, wranglerEnv()).trim().split('\n').at(-1)!.replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1')
    if (wranglerVersion !== manifest.wrangler) throw new ReleaseRefusal(`the installed wrangler is ${wranglerVersion}, release.json names ${manifest.wrangler}`)
    log(`${cliVersion}; wrangler ${wranglerVersion}`)

    // 3b. the installed `vibase instance` ([[OPS231]] D12): the dynamic import of the sibling cli/instance.js works from the installed package.
    // `help` proves the import; `status` with an empty config home proves the command runs and refuses at the settings file, before any network call.
    const vibaseBin = join(install, 'node_modules', '.bin', 'vibase')
    const instanceHelp = sh(vibaseBin, ['instance', 'help'], install)
    if (!/vibase instance status --env/.test(instanceHelp)) throw new ReleaseRefusal('the installed `vibase instance help` does not print the instance commands')
    const emptyConfig = join(root, 'empty-config')
    mkdirSync(emptyConfig)
    const noSettings = spawnSync(vibaseBin, ['instance', 'status', '--env', 'check'], { cwd: install, env: { ...cleanEnv(), XDG_CONFIG_HOME: emptyConfig }, encoding: 'utf8' })
    const expectedPath = join(emptyConfig, 'vibase', 'instances', 'check.json')
    if (noSettings.status !== 2 || !noSettings.stderr.includes(expectedPath)) throw new ReleaseRefusal(`the installed \`vibase instance status\` did not refuse at the missing settings file (exit ${noSettings.status}): ${noSettings.stderr.trim()}`)
    log(`vibase instance: help ok; status refuses at ${expectedPath} (exit 2)`)

    // 4. the installed migrations on a fresh local D1, applied by the installed wrangler.
    const base = parse(readFileSync(join(installed, 'wrangler.base.jsonc'), 'utf8')) as Record<string, any>
    const dbId = base.d1_databases[0].database_id as string
    const config = join(root, 'check.wrangler.jsonc')
    writeFileSync(
      config,
      JSON.stringify({ ...base, main: join(installed, 'worker', 'worker.js'), assets: { ...base.assets, directory: join(installed, 'assets') }, d1_databases: base.d1_databases.map((d: object) => ({ ...d, migrations_dir: join(installed, 'migrations') })) }),
    )
    const persist = join(root, 'state')
    sh(wranglerBin, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '-c', config], root, wranglerEnv())
    log(`applied ${manifest.migrations.length} migrations from the installed package to a fresh local D1`)

    // 5. the installed Worker and assets in workerd (the repo's Miniflare 4, as smoke:worker uses: wrangler 4.149.0's own Miniflare is a 5.x alpha with another API), VERSION and COMMIT from release.json.
    const workerDir = join(installed, 'worker')
    const mf = new Miniflare({
      port: 0,
      modules: true,
      scriptPath: join(workerDir, 'worker.js'),
      modulesRoot: workerDir,
      compatibilityDate: manifest.compatibility_date,
      d1Databases: { DB: dbId },
      d1Persist: join(persist, 'v3', 'd1'),
      r2Persist: false,
      r2Buckets: ['BODIES'],
      workflows: { MAIL_SYNC: { name: 'vibase-check-mail-sync', className: 'MailSyncWorkflow' } },
      workflowsPersist: false,
      assets: { directory: join(installed, 'assets'), binding: 'ASSETS', routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/connect', '/connect/*'] } } },
      bindings: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '', VERSION: manifest.version, COMMIT: manifest.commit },
      outboundService: () => new Response('no network in the release check', { status: 502 }),
    })
    try {
      const url = await mf.ready
      const res = await fetch(new URL('/health', url))
      const health = (await res.json()) as Record<string, any>
      const ok = res.status === 200 && health.status === 'ok' && health.version === manifest.version && health.commit === manifest.commit && health.migrations?.status === 'current'
      if (!ok) throw new ReleaseRefusal(`/health from the installed Worker is wrong (${res.status}): ${JSON.stringify(health)}`)
      log(`/health ${JSON.stringify(health)}`)
      const connect = await fetch(new URL('/connect', url), { redirect: 'manual' })
      const connectJs = await fetch(new URL('/connect/connect.js', url))
      if (connect.status !== 200 || connectJs.status !== 200) throw new ReleaseRefusal(`/connect is not served: /connect ${connect.status}, /connect/connect.js ${connectJs.status}`)
      log(`/connect ${connect.status}, /connect/connect.js ${connectJs.status}`)
      return { installPath: install, cliVersion, wranglerVersion, health, connectStatus: connect.status }
    } finally {
      await mf.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(PKG, 'dist', `vibase-${version}.tgz`)
  try {
    await checkRelease(arg)
    console.log('release check passed')
  } catch (e) {
    console.error(`release check FAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}
