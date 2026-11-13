// `pnpm release:check [<cli tarball> <server tarball>]` ([[OPS210]] D8, [[OPS240]]): proves the two built packages, not the source. The tarballs default to
// `packages/release/dist/vibase-cli-<v>.tgz` and `vibase-server-d1-<v>.tgz`. It extracts, scans, lays out and verifies each tarball, installs each into its OWN empty temp directory
// outside the repo with `npm install` (the only network read: the public npm registry, for the server's wrangler; `--prefer-offline`, never the repo's node_modules), runs the
// installed `vibase` and `vibase-server`, runs `npm exec --package <server tarball>`, resolves every `exports` entry, applies the installed migrations to a fresh local D1 with the installed
// wrangler, and runs the installed Worker and assets in workerd (Miniflare 4, the repo's test harness). Nothing is published; no Cloudflare call or credential is involved.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'
import { ReleaseRefusal } from '../src/errors.js'
import { assertNoForbidden, envDatabaseIds } from '../src/forbidden.js'
import { assertClientLayout, assertCommit, assertExportsResolve, assertServerLayout, CLIENT_MARKERS } from '../src/layout.js'
import { assertRelease, type ReleaseManifest } from '../src/manifest.js'
import { verifySums } from '../src/pack.js'
import { withGeneratedConfig } from '../../server-d1/scripts/instance/config.js'
import { deployArgs } from '../../server-d1/scripts/instance/upgrade.js'
import { wranglerEnv } from './build.js'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(PKG, '..', '..')

/** The child environment of the npm install: the user's PATH and HOME, nothing the repo's pnpm run exported (npm_*, pnpm_*). */
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|pnpm_|NPM_|PNPM_|INIT_CWD|CLOUDFLARE_|CLERK_)/.test(k)))

const sh = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv()) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export interface CheckResult {
  clientInstallPath: string
  serverInstallPath: string
  cliVersion: string
  serverVersion: string
  wranglerVersion: string
  health: Record<string, unknown>
  connectStatus: number
}

const empty = (root: string, name: string) => { const d = join(root, name); mkdirSync(d); return d }
const npmInstall = (dir: string, tarball: string) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'vibase-check', private: true }))
  sh('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-progress', tarball], dir)
}

export async function checkRelease(tarballs: { client: string; server: string }, log: (line: string) => void = console.log): Promise<CheckResult> {
  const clientTarball = resolve(tarballs.client)
  const serverTarball = resolve(tarballs.server)
  for (const t of [clientTarball, serverTarball]) if (!existsSync(t)) throw new ReleaseRefusal(`no such tarball: ${t}`)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibase-check-')))
  const inRepo = relative(REPO, root)
  if (!inRepo.startsWith('..') && !isAbsolute(inRepo)) throw new ReleaseRefusal(`the check directory ${root} is inside the repo`)
  try {
    const databaseIds = envDatabaseIds(readFileSync(join(REPO, 'packages', 'server-d1', 'wrangler.jsonc'), 'utf8'))
    const version = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version

    // 0. SHA256SUMS, when the tarballs sit beside it (a hand-repacked copy does not).
    if (dirname(clientTarball) === dirname(serverTarball) && existsSync(join(dirname(clientTarball), 'SHA256SUMS'))) {
      const bad = verifySums(dirname(clientTarball))
      if (bad.length > 0) throw new ReleaseRefusal(`SHA256SUMS does not match the tarballs: ${bad.join(', ')}`)
      log('SHA256SUMS ok: both tarballs')
    }

    // 1. the client tarball: extract, refuse forbidden content (first: it names a planted file by kind), the exact file list and fields, no dependencies, no instance code.
    const clientExtract = empty(root, 'extract-cli')
    sh('tar', ['-xzf', clientTarball, '-C', clientExtract], root)
    const clientPkg = join(clientExtract, 'package')
    assertNoForbidden(clientPkg, { databaseIds })
    assertClientLayout(clientPkg, version)
    log(`client tarball ok: @vibase/cli ${version}, ${readdirSync(clientPkg).length} top-level entries, no dependencies, no instance code`)

    // 2. the server tarball: the same, then release.json against the files and the version and commit agreements.
    const serverExtract = empty(root, 'extract-server')
    sh('tar', ['-xzf', serverTarball, '-C', serverExtract], root)
    const serverPkg = join(serverExtract, 'package')
    assertNoForbidden(serverPkg, { databaseIds })
    assertServerLayout(serverPkg, version)
    assertRelease(serverPkg)
    const manifest = JSON.parse(readFileSync(join(serverPkg, 'release.json'), 'utf8')) as ReleaseManifest
    assertCommit(manifest.commit)
    log(`server tarball ok: ${manifest.name} ${manifest.version} @ ${manifest.commit}, ${Object.keys(manifest.files).length} files verified; both packages at ${version}`)

    // 3. the client, installed alone: nothing but @vibase/cli lands, and `vibase instance` only points at the server package.
    const clientInstall = empty(root, 'install-cli')
    npmInstall(clientInstall, clientTarball)
    const modules = join(clientInstall, 'node_modules')
    const landed = readdirSync(modules).filter((n) => !n.startsWith('.'))
    const scoped = existsSync(join(modules, '@vibase')) ? readdirSync(join(modules, '@vibase')) : []
    if (landed.join() !== '@vibase' || scoped.join() !== 'cli') throw new ReleaseRefusal(`the client install holds ${[...landed, ...scoped.map((n) => `@vibase/${n}`)].join(', ')}, expected only @vibase/cli`)
    assertNoForbidden(join(modules, '@vibase', 'cli'), { databaseIds })
    assertClientLayout(join(modules, '@vibase', 'cli'), version)
    const vibaseBin = join(modules, '.bin', 'vibase')
    const cliVersion = sh(vibaseBin, ['--version'], clientInstall).trim()
    if (cliVersion !== `vibase-cli/${version}`) throw new ReleaseRefusal(`the installed vibase prints ${cliVersion}, expected vibase-cli/${version}`)
    const redirect = spawnSync(vibaseBin, ['instance', 'status', '--env', 'check'], { cwd: clientInstall, env: cleanEnv(), encoding: 'utf8' })
    const expectedRedirect = `instance commands moved to the server package: npx @vibase/server-d1@${version} <command> …\n`
    if (redirect.status !== 2 || redirect.stderr !== expectedRedirect || redirect.stdout !== '') throw new ReleaseRefusal(`the installed \`vibase instance status\` did not redirect (exit ${redirect.status}): ${redirect.stderr.trim()}`)
    log(`client installed alone (node_modules: @vibase/cli only): ${cliVersion}; vibase instance status prints the redirect and exits 2`)

    // 4. the server, installed alone into another empty directory.
    const install = empty(root, 'install-server')
    npmInstall(install, serverTarball)
    const installed = join(install, 'node_modules', '@vibase', 'server-d1')
    assertNoForbidden(installed, { databaseIds })
    assertRelease(installed)
    assertServerLayout(installed, version)
    const serverBin = join(install, 'node_modules', '.bin', 'vibase-server')
    const serverVersion = sh(serverBin, ['--version'], install).trim()
    if (serverVersion !== `vibase-server/${manifest.version} (${manifest.commit})`) throw new ReleaseRefusal(`the installed vibase-server prints ${serverVersion}, expected vibase-server/${manifest.version} (${manifest.commit})`)
    const wranglerBin = join(install, 'node_modules', '.bin', 'wrangler')
    const wranglerVersion = sh(wranglerBin, ['--version'], install, wranglerEnv()).trim().split('\n').at(-1)!.replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1')
    if (wranglerVersion !== manifest.wrangler) throw new ReleaseRefusal(`the installed wrangler is ${wranglerVersion}, release.json names ${manifest.wrangler}`)
    log(`${serverVersion}; wrangler ${wranglerVersion}`)

    // 4b. the installed `vibase-server` ([[OPS231]] D12, [[OPS240]] D21): `--help` lists the commands; `status` with an empty config home proves the command runs and refuses at the settings file, before any network call.
    const help = sh(serverBin, ['--help'], install)
    if (!/vibase-server status --env/.test(help)) throw new ReleaseRefusal('the installed `vibase-server --help` does not print the commands')
    const emptyConfig = join(root, 'empty-config')
    mkdirSync(emptyConfig)
    const noSettings = spawnSync(serverBin, ['status', '--env', 'check'], { cwd: install, env: { ...cleanEnv(), XDG_CONFIG_HOME: emptyConfig }, encoding: 'utf8' })
    const expectedPath = join(emptyConfig, 'vibase', 'instances', 'check.json')
    if (noSettings.status !== 2 || !noSettings.stderr.includes(expectedPath)) throw new ReleaseRefusal(`the installed \`vibase-server status\` did not refuse at the missing settings file (exit ${noSettings.status}): ${noSettings.stderr.trim()}`)
    log(`vibase-server: --help ok; status refuses at ${expectedPath} (exit 2)`)
    // [[OPS234]]: `upgrade` is in the installed bundle, refuses at the same missing settings file, and the installed wrangler accepts the exact deploy argument list
    // `upgrade` builds (plus `--dry-run`, which makes no network call) against a config generated from a sample settings file; the settings' vars must survive `--var`.
    if (!/vibase-server upgrade --env <name> \[--dry-run\] \[--rollback\]/.test(help)) throw new ReleaseRefusal('the installed `vibase-server --help` does not list `upgrade [--dry-run] [--rollback]`')
    const noSettingsUpgrade = spawnSync(serverBin, ['upgrade', '--env', 'check'], { cwd: install, env: { ...cleanEnv(), XDG_CONFIG_HOME: emptyConfig }, encoding: 'utf8' })
    if (noSettingsUpgrade.status !== 2 || !noSettingsUpgrade.stderr.includes(expectedPath)) throw new ReleaseRefusal(`the installed \`vibase-server upgrade\` did not refuse at the missing settings file (exit ${noSettingsUpgrade.status}): ${noSettingsUpgrade.stderr.trim()}`)
    const sample = { version: 1 as const, env: 'check', worker: 'vault-check', api_host: 'api.check.invalid', d1: { name: 'vault-check', id: '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b' }, r2_bucket: 'vault-check-bodies', workflow: { name: 'vault-check-mail-sync' }, vars: { AUTH_PROVIDER: '', SAMPLE_SETTING: 'kept-by-var' } }
    const dryRun = withGeneratedConfig({ packageDir: installed, settings: sample, tmpRoot: root }, (configPath) => sh(wranglerBin, [...deployArgs(manifest.version, manifest.commit, configPath), '--dry-run'], root, wranglerEnv()))
    for (const needle of [`VERSION`, `COMMIT`, `SAMPLE_SETTING`, `Total Upload`]) if (!dryRun.includes(needle)) throw new ReleaseRefusal(`the installed wrangler's deploy --dry-run of the upgrade argument list did not report ${needle}: ${dryRun.trim()}`)
    log('vibase-server upgrade: help lists it; refuses at the missing settings file (exit 2); the installed wrangler accepts the deploy argument list (--dry-run) with the settings vars and the VERSION and COMMIT vars')

    // [[OPS232]]: `setup` is in the installed bundle, refuses at the missing secrets file (an empty config home, no Cloudflare values), and the bundle carries the bootstrap
    // program in the one file: no lazy chunk, no root `.env` loader. cli/ holds server.js alone: the client is another package.
    if (!/vibase-server setup --env <name> --api-host <host>/.test(help)) throw new ReleaseRefusal('the installed `vibase-server --help` does not list `setup --env <name> --api-host <host>`')
    const noSecretsSetup = spawnSync(serverBin, ['setup', '--env', 'check', '--api-host', 'api.check.invalid', '--auth', 'none'], { cwd: install, env: { ...cleanEnv(), XDG_CONFIG_HOME: emptyConfig }, encoding: 'utf8' })
    const expectedSecrets = join(emptyConfig, 'vibase', 'instances', 'check.env')
    if (noSecretsSetup.status !== 2 || !noSecretsSetup.stderr.includes(expectedSecrets)) throw new ReleaseRefusal(`the installed \`vibase-server setup\` did not refuse at the missing secrets file (exit ${noSecretsSetup.status}): ${noSecretsSetup.stderr.trim()}`)
    const cliDir = join(installed, 'cli')
    const cliFiles = readdirSync(cliDir).sort()
    if (cliFiles.join() !== 'server.js') throw new ReleaseRefusal(`the installed cli/ holds ${cliFiles.join(', ')}, expected only server.js (a lazy chunk, or the client?)`)
    const serverText = readFileSync(join(cliDir, 'server.js'), 'utf8')
    if (!serverText.includes('ops.init_deployment')) throw new ReleaseRefusal('the installed cli/server.js does not carry the bootstrap program')
    if (/\bfrom\s*["']\.{1,2}\//.test(serverText) || /\bimport\(\s*["']\.{1,2}\//.test(serverText)) throw new ReleaseRefusal('the installed cli/server.js imports a file beside it (a lazy chunk)')
    if (/loadEnvFile/.test(serverText)) throw new ReleaseRefusal('the installed cli/server.js carries the root .env loader')
    const clientText = readFileSync(join(modules, '@vibase', 'cli', 'cli', 'vibase.js'), 'utf8')
    log(`vibase-server setup: help lists it; refuses at ${expectedSecrets} (exit 2); cli/ is server.js (${serverText.length} bytes, bootstrap bundled, no chunk, no .env loader); the client's vibase.js (${clientText.length} bytes) carries none of ${CLIENT_MARKERS.join(', ')}`)

    // 5. the npx path of D2: npm's own resolution of the single bin, from an empty directory, with a private npm cache so nothing is left behind and no stale copy is found.
    const execDir = empty(root, 'exec')
    const cache = empty(root, 'npm-cache')
    const exec = sh('npm', ['exec', '--yes', '--prefer-offline', '--no-audit', '--no-fund', '--package', serverTarball, '--', 'vibase-server', '--version'], execDir, { ...cleanEnv(), npm_config_cache: cache })
    if (exec.trim().split('\n').at(-1) !== serverVersion) throw new ReleaseRefusal(`npm exec --package <server tarball> -- vibase-server --version printed ${JSON.stringify(exec.trim())}, expected ${serverVersion}`)
    log(`npm exec --package <server tarball> -- vibase-server --version: ${exec.trim()}`)

    // 6. every D23 (a) `exports` entry, resolved by Node from the consumer directory the server was installed into.
    const resolved = assertExportsResolve(install)
    log(`exports resolve from a consumer: ${resolved.map((r) => r.entry).join(', ')}`)

    // 7. the installed migrations on a fresh local D1, applied by the installed wrangler.
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

    // 8. the installed Worker and assets in workerd (the repo's Miniflare 4, as smoke:worker uses: wrangler 4.149.0's own Miniflare is a 5.x alpha with another API), VERSION and COMMIT from release.json.
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
      return { clientInstallPath: clientInstall, serverInstallPath: install, cliVersion, serverVersion, wranglerVersion, health, connectStatus: connect.status }
    } finally {
      await mf.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const [client, server] = args.length === 2 ? args : [join(PKG, 'dist', `vibase-cli-${version}.tgz`), join(PKG, 'dist', `vibase-server-d1-${version}.tgz`)]
  try {
    await checkRelease({ client: client!, server: server! })
    console.log('release check passed')
  } catch (e) {
    console.error(`release check FAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}
