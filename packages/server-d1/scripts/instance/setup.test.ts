// `vibase instance setup` ([[OPS232]] P1-P6): every case runs against the kit's fake wrangler runner and fake fetch, a simulated account, and a real
// local D1 behind the bootstrap step. Nothing here spawns a tool, reaches Cloudflare or Clerk, or reads a .env.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { reconcileEnvBlock } from '../setup/config-editor.js'
import { makeClerk } from '../setup/test/clerk-world.js'
import { runInstance } from './main.js'
import { parseInstanceSetupArgs } from './setup-args.js'
import { ALL_MIGRATIONS, API_HOST, CLERK_ARGS, CLERK_SECRET_VALUES, CLERK_SECRETS_TEXT, NONE_ARGS, isWrite, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { cleanup, mkTmp, TOKEN, UUID, validSettings } from './test-kit.js'
import { loadSettings } from './settings.js'
import { deployArgs } from './upgrade.js'
import { InstanceRefusal } from './types.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'

let d1: WorkerD1
beforeAll(async () => { d1 = await openWorkerD1() }, 60_000)
afterAll(async () => { await d1.dispose() })
afterEach(async () => { cleanup(); await d1.reset() })

const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld => setupWorld({ d1, ...o })
const run = (s: SetupWorld, argv: string[] = NONE_ARGS) => runSetup(argv, s.w.deps)
const verbs = (s: SetupWorld) => s.w.wrangler.map((c) => c.args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' '))
const FRESH_SIM = {}
/** The smoked1 shape: resources exist by name, the database is migrated and bootstrapped, `/health` shows a source deploy's sha. */
const ADOPTED = () => ({ d1s: [{ uuid: UUID, name: 'vault-demo' }], r2s: ['vault-demo-bodies'], applied: [...ALL_MIGRATIONS], marker: { organization_id: 'org-1', auth_provider: 'none', auth_org_id: 'demo', organizations: 1 }, deployed: { version: 'a'.repeat(40), commit: null } })
const configsOf = (s: SetupWorld) => s.w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
const surface = (s: SetupWorld) => [s.w.all(), s.settings() ?? '', ...s.w.wrangler.map((c) => c.args.join(' ')), ...s.w.wrangler.flatMap((c) => (c.configText ? [c.configText] : []))].join('\n')

describe('arguments (P1)', () => {
  it('takes setup:remote\'s flags with --secrets-file and --settings, and no --clerk-env-file', () => {
    const o = parseInstanceSetupArgs(['--env', 'demo', '--api-host', API_HOST, '--owner-email', 'o@x.invalid', '--settings', '/s/demo.json', '--secrets-file', '/s/demo.env', '--only', 'migrate,deploy', '--rotate-secrets', '--no-dcr'])
    expect(o.settingsPath).toBe('/s/demo.json')
    expect(o.secretsPath).toBe('/s/demo.env')
    expect(o.opts).toMatchObject({ env: 'demo', apiHost: API_HOST, auth: 'clerk', workerName: 'vault-demo', d1Name: 'vault-demo', r2Name: 'vault-demo-bodies', only: ['migrate', 'deploy'], rotateSecrets: true, noDcr: true })
    expect(() => parseInstanceSetupArgs([...NONE_ARGS, '--clerk-env-file', '.env.demo'])).toThrow(/clerk-env-file/)
    expect(() => parseInstanceSetupArgs(['--api-host', API_HOST, '--auth', 'none'])).toThrow(/--env/)
    expect(() => parseInstanceSetupArgs([...NONE_ARGS, '--no-dcr'])).toThrow(/--auth clerk/)
  })
})

describe('fresh install, release mode', () => {
  it('runs D11\'s steps in order with the package\'s wrangler on a generated config, creates the settings file, and a second run changes nothing', async () => {
    const s = world({ sim: FRESH_SIM })
    expect(await run(s)).toBe(0)
    expect(s.w.err).toEqual([])
    expect(s.rows().map((r) => `${r.status} ${r.step}`)).toEqual(['ok preflight', 'create config:resources', 'create config:write', 'update migrate', 'create bootstrap', 'update deploy', 'ok secrets', 'ok verify'])
    // Every wrangler call is `<args> -c <generated config>`, no pnpm, git or --env, and the config is gone afterwards.
    for (const c of s.w.wrangler) {
      expect(c.args.at(-2)).toBe('-c')
      expect(c.configPath!.startsWith(s.w.tmpRoot)).toBe(true)
      expect(c.configText).not.toBeNull()
      expect(c.args).not.toContain('--env')
      expect(c.args.join(' ')).not.toMatch(/\b(pnpm|git)\b/)
    }
    expect(readdirSync(s.w.tmpRoot)).toEqual([])
    expect(s.writes().map((a) => a.slice(0, 3).join(' '))).toEqual(['d1 create vault-demo', 'r2 bucket create', 'd1 migrations apply', 'deploy --no-bundle --var'])
    const deploy = s.w.wrangler.find((c) => c.args[0] === 'deploy')!
    expect(deploy.args).toEqual(deployArgs('0.1.0', 'abc1234', deploy.configPath!))
    expect(s.sim.d1s).toHaveLength(1)
    expect(s.sim.opened).toHaveLength(1)
    const settings = loadSettings(s.w.settingsPath, 'demo')
    expect(settings).toEqual({ version: 1, env: 'demo', worker: 'vault-demo', api_host: API_HOST, d1: { name: 'vault-demo', id: s.sim.d1s[0]!.uuid }, r2_bucket: 'vault-demo-bodies', workflow: { name: 'vault-demo-mail-sync' }, vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' } })

    // The second identical run: every step ok, zero writes, the file byte for byte the same.
    const before = s.settings()
    const calls = s.w.wrangler.length
    const out = s.w.out.length
    const opened = s.sim.opened.length
    expect(await run(s)).toBe(0)
    expect(s.rows().slice(8).map((r) => `${r.status} ${r.step}`)).toEqual(['ok preflight', 'ok config:resources', 'ok config:write', 'ok migrate', 'ok bootstrap', 'ok deploy', 'ok secrets', 'ok verify'])
    expect(s.w.wrangler.slice(calls).map((c) => c.args).filter(isWrite)).toEqual([])
    expect(s.sim.opened).toHaveLength(opened)
    expect(s.settings()).toBe(before)
    expect(s.w.out.length).toBeGreaterThan(out)
  })

  it('creates the settings directory when it does not exist (--settings)', async () => {
    const s = world({})
    const path = join(mkTmp(), 'nested', 'new', 'demo.json')
    expect(await run(s, [...NONE_ARGS, '--settings', path])).toBe(0)
    expect(loadSettings(path, 'demo').d1.id).toBe(s.sim.d1s[0]!.uuid)
  })
})

describe('adoption and the settings file', () => {
  const fx = JSON.parse(readFileSync(new URL('./test/source-env-blocks.json', import.meta.url), 'utf8')) as Record<string, any>
  const pick = (c: Record<string, any>) => ({ name: c.name, routes: c.routes, d1: { ...c.d1_databases[0], migrations_dir: undefined }, r2_buckets: c.r2_buckets, vars: c.vars })
  const FLAGS = [...NONE_ARGS, '--web-origin', 'https://app.demo.invalid']

  it('adopts existing resources by name (the smoked1 shape): nothing created, the file written with the adopted id, the marker found', async () => {
    const s = world({ sim: ADOPTED() })
    expect(await run(s, FLAGS)).toBe(0)
    expect(s.writes().map((a) => a[0])).toEqual(['deploy'])
    expect(s.sim.opened).toHaveLength(0)
    expect(s.rows().find((r) => r.step === 'bootstrap')).toMatchObject({ status: 'ok' })
    expect(s.rows().find((r) => r.step === 'bootstrap')!.detail).toMatch(/marker none:demo present/)
    expect(s.rows().find((r) => r.step === 'config:resources')!.status).toBe('ok')
    expect(loadSettings(s.w.settingsPath, 'demo').d1).toEqual({ name: 'vault-demo', id: UUID })
    expect(s.w.out.join('\n')).toMatch(/not a release version/)
  })

  it('the generated config carries the name, routes, bindings and vars setup:remote writes into wrangler.jsonc (frozen fixture, both auth modes)', async () => {
    // The fixture is today's source output; the source still produces it.
    const text = readFileSync(new URL('../setup/test/wrangler.fixture.jsonc', import.meta.url), 'utf8')
    expect((parse(reconcileEnvBlock(text, { env: 'demo', workerName: 'vault-demo', d1Name: 'vault-demo', d1Id: UUID, r2Name: 'vault-demo-bodies', apiHost: API_HOST, corsOrigins: 'https://app.demo.invalid' }).text) as any).env.demo).toEqual(fx.none)

    const none = world({ sim: ADOPTED() })
    expect(await run(none, FLAGS)).toBe(0)
    expect(pick(configsOf(none).at(-1)!)).toEqual(pick(fx.none))

    const clerk = world({ sim: { ...ADOPTED(), marker: { organization_id: 'org-1', auth_provider: 'clerk', auth_org_id: 'https://acme-test-12.clerk.accounts.dev', organizations: 1 }, clerk: makeClerk() }, secretsText: CLERK_SECRETS_TEXT })
    expect(await run(clerk, CLERK_ARGS)).toBe(0)
    expect(pick(configsOf(clerk).at(-1)!)).toEqual(pick(fx.clerk))
    expect(loadSettings(clerk.w.settingsPath, 'demo').vars).toEqual(fx.clerk.vars)
  })

  it('a settings file that differs from the flags fails config:write, names the key, and stays unchanged', async () => {
    const s = world({ sim: ADOPTED(), settings: validSettings({ r2_bucket: 'some-other-bucket' }) })
    const before = s.settings()
    expect(await run(s)).toBe(3)
    const fail = s.rows().find((r) => r.status === 'fail')!
    expect(fail.step).toBe('config:write')
    expect(fail.detail).toMatch(/r2_bucket/)
    expect(s.rows().map((r) => r.step)).not.toContain('migrate')
    expect(s.settings()).toBe(before)
    expect(s.writes()).toEqual([])
  })
})

describe('refusals and failures (the matrix)', () => {
  /** Exit 2: nothing ran, nothing was written. */
  const refused = (s: SetupWorld, code: number, re: RegExp, existingSettings = false) => {
    expect(code).toBe(2)
    expect(s.w.err.join('\n')).toMatch(re)
    expect(s.w.err.join('\n')).toMatch(/^vibase instance setup: /)
    expect(s.writes()).toEqual([])
    expect(s.sim.opened).toEqual([])
    expect(s.sim.bulk).toEqual([])
    if (!existingSettings) expect(s.settings()).toBeNull()
    expect(readdirSync(s.w.tmpRoot)).toEqual([])
  }

  it('a tampered installed file', async () => {
    const s = world({})
    appendFileSync(join(s.w.pkg.dir, 'worker', 'worker.js'), '// tampered')
    refused(s, await run(s), /does not match its release\.json/)
    expect(s.w.wrangler).toHaveLength(0)
    expect(s.w.fetchUrls).toEqual([])
  })
  it('a group-readable secrets file', async () => {
    const s = world({ secretsMode: 0o640 })
    refused(s, await run(s), /group or others/)
    expect(s.w.wrangler).toHaveLength(0)
  })
  it('a missing CONFIRM_REMOTE (a dry run does not need it)', async () => {
    const s = world({ processEnv: { CONFIRM_REMOTE: undefined } })
    refused(s, await run(s), /CONFIRM_REMOTE=1/)
    expect(s.w.wrangler).toHaveLength(0)
    const d = world({ processEnv: { CONFIRM_REMOTE: undefined } })
    expect(await run(d, [...NONE_ARGS, '--dry-run'])).toBe(0)
  })
  it('worker "vault" in an existing settings file', async () => {
    const s = world({ settings: validSettings({ worker: 'vault' }) })
    refused(s, await run(s), /unknown env demo/, true)
    expect(s.w.wrangler).toHaveLength(0)
  })
  it('a wrangler that cannot be resolved (the refusal the real runner throws)', async () => {
    const s = world({ intercept: () => { throw new InstanceRefusal('cannot resolve the wrangler of the installed package at /x: not found: reinstall it') } })
    refused(s, await run(s), /cannot resolve the wrangler/)
  })
  it('a package whose wrangler cannot be resolved, through the real runner, refuses before any spawn', async () => {
    const s = world({})
    const outer = mkTmp('ops232-outer-')
    const pkgDir = join(outer, 'node_modules', 'vibase')
    cpSync(s.w.pkg.dir, pkgDir, { recursive: true })
    mkdirSync(join(outer, 'node_modules', 'wrangler'), { recursive: true })
    // The nearest `wrangler` has no bin: it cannot be run, and nothing is ever spawned (pnpm's NODE_PATH would otherwise find the repo's).
    writeFileSync(join(outer, 'node_modules', 'wrangler', 'package.json'), JSON.stringify({ name: 'wrangler', version: '0.0.0' }))
    const out: string[] = []
    const err: string[] = []
    const code = await runInstance(['setup', ...NONE_ARGS], { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), env: { XDG_CONFIG_HOME: s.w.config, PATH: process.env.PATH, HOME: s.w.deps.homedir, CONFIRM_REMOTE: '1' } }, pkgDir, { fetch: s.w.deps.fetch, now: s.w.deps.now, sleep: s.w.deps.sleep })
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/vibase instance setup: .*wrangler/)
    expect(err.join('')).toContain(pkgDir)
    expect(existsSync(s.w.settingsPath)).toBe(false)
  })
  it('a live instance that is a newer semver than the package', async () => {
    const s = world({ sim: { deployed: { version: '9.9.9', commit: 'f'.repeat(7) } } })
    refused(s, await run(s), /9\.9\.9.*0\.1\.0|newer/)
    expect(s.w.err.join('\n')).toMatch(/upgrade --rollback/)
    expect(s.w.wrangler).toHaveLength(0)
  })

  const failedAt = (s: SetupWorld, code: number, step: string) => {
    expect(code).toBe(3)
    const rows = s.rows()
    expect(rows.at(-1)).toMatchObject({ status: 'fail', step })
    expect(s.w.err.join('\n')).toMatch(new RegExp(`^vibase instance setup: ${step} failed`))
  }
  it('ahead at migrate: exit 3, nothing deployed', async () => {
    const s = world({ sim: { ...ADOPTED(), applied: [...ALL_MIGRATIONS, '0003_from_the_future.sql'] } })
    failedAt(s, await run(s), 'migrate')
    expect(s.writes().filter((a) => a[0] === 'deploy' || a.includes('apply'))).toEqual([])
    expect(s.w.out.join('\n')).toMatch(/0003_from_the_future/)
  })
  it('the deploy fails: exit 3, no secrets and no verify', async () => {
    const s = world({ sim: { ...ADOPTED(), failDeploy: true } })
    failedAt(s, await run(s), 'deploy')
    expect(s.rows().map((r) => r.step)).not.toContain('secrets')
    expect(s.sim.bulk).toEqual([])
  })
  it('verify never sees the package version: exit 3 after the 300 s bound on the injected clock', async () => {
    const s = world({ sim: { ...ADOPTED(), deployed: { version: '0.0.9', commit: null }, deployNoop: true } })
    failedAt(s, await run(s), 'verify')
    expect(s.w.clock.t).toBeGreaterThanOrEqual(300_000)
    expect(s.w.clock.t).toBeLessThan(400_000)
  })
  it('--dry-run exits 0 and writes nothing: no resource, no settings file, no deploy, no D1', async () => {
    const s = world({ processEnv: { CONFIRM_REMOTE: undefined } })
    expect(await run(s, [...NONE_ARGS, '--dry-run'])).toBe(0)
    expect(s.writes()).toEqual([])
    expect(s.settings()).toBeNull()
    expect(s.sim.opened).toEqual([])
    expect(s.sim.d1s).toEqual([])
    expect(s.rows().find((r) => r.step === 'config:resources')).toMatchObject({ status: 'create' })
    expect(s.rows().find((r) => r.step === 'config:write')).toMatchObject({ status: 'create' })
    expect(s.rows().find((r) => r.step === 'deploy')).toMatchObject({ status: 'blocked' })
    expect(s.w.out.join('\n')).toMatch(/dry run complete/)
    expect(readdirSync(s.w.tmpRoot)).toEqual([])
  })
})

describe('bootstrap from the release (P3, P4)', () => {
  const OPERATOR = [...NONE_ARGS, '--owner-email', 'owner@example.com', '--operator-agent', 'operator', '--key-env', 'DEMO_KEY']
  const count = async (table: string) => ((await d1.d1.prepare(`select count(*) as n from ${table}`).first()) as { n: number }).n

  it('opens the generated config with remoteBindings and no persistence, and writes the marker, the organisation and the operator key to the secrets file', async () => {
    const s = world({ sim: { ...ADOPTED(), marker: null } })
    expect(await run(s, OPERATOR)).toBe(0)
    expect(s.sim.opened).toHaveLength(1)
    const { opts, configText } = s.sim.opened[0]!
    expect(opts).toMatchObject({ remoteBindings: true, persist: false })
    expect(opts.configPath.startsWith(s.w.tmpRoot)).toBe(true)
    expect(opts.env).toMatchObject({ CLOUDFLARE_API_TOKEN: TOKEN })
    expect(JSON.parse(configText!).d1_databases[0]).toMatchObject({ database_id: UUID, remote: true })
    expect(((await d1.d1.prepare('select auth_provider, auth_org_id from deployment').first()) as any)).toEqual({ auth_provider: 'none', auth_org_id: 'demo' })
    expect(await count('organizations')).toBe(1)
    expect(await count('api_keys')).toBe(1)
    const file = readFileSync(s.w.secretsPath, 'utf8')
    const key = /^DEMO_KEY=(\S+)$/m.exec(file)?.[1]
    expect(key).toBeTruthy()
    expect(file.startsWith(`CLOUDFLARE_ACCOUNT_ID=`)).toBe(true)
    expect(statSync(s.w.secretsPath).mode & 0o777).toBe(0o600)
    expect(surface(s).includes(key!)).toBe(false)
    expect(s.w.fetchUrls.join('\n').includes(key!)).toBe(false)
  })

  it('--auth clerk writes the marker (the issuer) and the organisation, and no human', async () => {
    const s = world({ sim: { ...ADOPTED(), marker: null, clerk: makeClerk() }, secretsText: CLERK_SECRETS_TEXT })
    expect(await run(s, CLERK_ARGS)).toBe(0)
    expect(((await d1.d1.prepare('select auth_provider, auth_org_id from deployment').first()) as any)).toEqual({ auth_provider: 'clerk', auth_org_id: 'https://acme-test-12.clerk.accounts.dev' })
    expect(await count('organizations')).toBe(1)
    expect(await count('users')).toBe(0)
    expect(s.rows().find((r) => r.step === 'clerk')).toBeTruthy()
  })

  it('a --key-env already in the secrets file refuses before any D1 write and leaves the file alone', async () => {
    const s = world({ sim: { ...ADOPTED(), marker: null }, secretsText: `CLOUDFLARE_ACCOUNT_ID=a-0000\nCLOUDFLARE_API_TOKEN=${TOKEN}\nDEMO_KEY=already-here-1234\n` })
    const before = readFileSync(s.w.secretsPath, 'utf8')
    expect(await run(s, OPERATOR)).toBe(3)
    expect(s.rows().at(-1)).toMatchObject({ status: 'fail', step: 'bootstrap' })
    expect(s.w.out.join('\n')).toMatch(/DEMO_KEY is already set/)
    expect(s.sim.opened).toEqual([])
    expect(await count('deployment')).toBe(0)
    expect(readFileSync(s.w.secretsPath, 'utf8')).toBe(before)
    expect(s.w.out.join('\n').includes('already-here-1234')).toBe(false)
  })
})

describe('secrets and side effects', () => {
  const secretValues = [...CLERK_SECRET_VALUES, TOKEN]

  it('Clerk and Gmail values reach the runner only as `secret bulk` stdin, and no output, file or argv carries one', async () => {
    const s = world({ sim: { ...ADOPTED(), marker: null, clerk: makeClerk() }, secretsText: CLERK_SECRETS_TEXT })
    expect(await run(s, CLERK_ARGS)).toBe(0)
    const bulk = s.w.wrangler.filter((c) => c.args.includes('secret') && c.args.includes('bulk'))
    expect(bulk).toHaveLength(1)
    expect(Object.keys(JSON.parse(bulk[0]!.input!)).sort()).toEqual(['CLERK_JWT_KEY', 'CLERK_SECRET_KEY', 'CREDENTIALS_KEY', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET'])
    for (const c of s.w.wrangler) if (c !== bulk[0]) expect(c.input).toBeUndefined()
    const seen = surface(s)
    for (const v of secretValues) expect(seen.includes(v), `a secret value reached the surface`).toBe(false)
    expect(s.w.fetchCalls.map((f) => f.url).join('\n').includes(CLERK_SECRET_VALUES[0]!)).toBe(false)
    // Public values travel into the settings file; secrets do not.
    const settings = JSON.parse(s.settings()!)
    expect(settings.vars.GOOGLE_CLIENT_ID).toBe('gid-123.apps.googleusercontent.com')
    for (const v of CLERK_SECRET_VALUES) expect(JSON.stringify(settings).includes(v)).toBe(false)
  })

  it('a failing wrangler that echoes its whole environment leaks nothing into the output', async () => {
    const s = world({ sim: { ...ADOPTED(), failDeploy: true, clerk: makeClerk(), marker: { organization_id: 'o', auth_provider: 'clerk', auth_org_id: 'https://acme-test-12.clerk.accounts.dev', organizations: 1 } }, secretsText: CLERK_SECRETS_TEXT })
    expect(await run(s, CLERK_ARGS)).toBe(3)
    const deploy = s.w.wrangler.find((c) => c.args[0] === 'deploy')!
    expect(deploy.env.CLOUDFLARE_API_TOKEN).toBe(TOKEN)
    const seen = surface(s)
    for (const v of secretValues) expect(seen.includes(v)).toBe(false)
    expect(s.w.err.join('\n')).toContain('***')
  })

  it('reads no root .env: the setup modules name no repo path and no process environment', () => {
    for (const f of ['setup.ts', 'setup-args.ts', 'setup-steps.ts']) {
      const text = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      expect(text, f).not.toMatch(/ROOT_ENV_PATH|loadRootEnv|env-file\.js|readEnvText|loadEnvFile|process\.env|REPO_ROOT|CONFIG_PATH/)
    }
  })
})

describe('the instance entry', () => {
  it('lists setup in the help', async () => {
    const { INSTANCE_HELP } = await import('./main.js')
    expect(INSTANCE_HELP).toMatch(/vibase instance setup --env <name> --api-host <host>/)
    expect(INSTANCE_HELP).toMatch(/--secrets-file/)
    expect(INSTANCE_HELP).toMatch(/Exit 0: done, or the dry run is complete; 2: refused before the first step; 3: a step failed/)
  })
  it('setup with an empty config home and no Cloudflare values refuses at the secrets path (real deps, before any network call)', async () => {
    const xdg = mkTmp()
    const err: string[] = []
    const s = world({})
    const code = await runInstance(['setup', ...NONE_ARGS], { stdout: () => {}, stderr: (t) => void err.push(t), env: { XDG_CONFIG_HOME: xdg, PATH: process.env.PATH } }, s.w.pkg.dir)
    expect(code).toBe(2)
    expect(err.join('')).toContain(join(xdg, 'vibase', 'instances', 'demo.env'))
  })
})
