// `vibase-server setup` ([[OPS232]] P1-P6): every case runs against the kit's fake wrangler runner and fake fetch, a simulated account, and a real
// local D1 behind the bootstrap step. Nothing here spawns a tool, reaches Cloudflare or Clerk, or reads a .env.
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CLERK_ONLY_STEPS, STEP_NAMES } from '../setup/types.js'
import { reconcileEnvBlock } from '../setup/config-editor.js'
import { makeClerk } from '../setup/test/clerk-world.js'
import { runInstance } from './main.js'
import { parseInstanceSetupArgs } from './setup-args.js'
import {
  ALL_MIGRATIONS,
  API_HOST,
  CLERK_ARGS,
  CLERK_SECRET_VALUES,
  CLERK_SECRETS_TEXT,
  NONE_ARGS,
  isWrite,
  setupWorld,
  type SetupWorld,
  type SetupWorldOptions,
} from './setup-kit.js'
import { runSetup } from './setup.js'
import { CONTROL_ALL, CONTROL_UUID, cleanup, mkTmp, packageLine, TOKEN, UUID, noControlSettings } from './test-kit.js'
import { loadSettings } from './settings.js'
import { deployArgs } from './upgrade.js'
import { InstanceRefusal } from './types.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'

let d1: WorkerD1
beforeAll(async () => {
  d1 = await openWorkerD1()
}, 60_000)
afterAll(async () => {
  await d1.dispose()
})
afterEach(async () => {
  cleanup()
  await d1.reset()
})

// [[OPS493]]: a person at a terminal who says yes; a refusal must have happened before the question (`refused` checks it).
const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld =>
  setupWorld({ d1, terminal: true, answers: ['y', 'y', 'y', 'y'], ...o })
const run = (s: SetupWorld, argv: string[] = NONE_ARGS) => runSetup(argv, s.w.deps)
const verbs = (s: SetupWorld) =>
  s.w.wrangler.map((c) =>
    c.args
      .filter((a) => !a.startsWith('-'))
      .slice(0, 3)
      .join(' '),
  )
const FRESH_SIM = {}
/** The smoked1 shape: resources exist by name, the database is migrated and bootstrapped, `/health` shows a source deploy's sha. */
const ADOPTED = () => ({
  d1s: [
    { uuid: UUID, name: 'vault-demo' },
    { uuid: CONTROL_UUID, name: 'vb-control-demo' },
  ],
  r2s: ['vault-demo-bodies'],
  applied: [...ALL_MIGRATIONS],
  controlApplied: [...CONTROL_ALL],
  marker: { organization_id: 'org-1', auth_provider: 'none', auth_org_id: 'demo', organizations: 1 },
  deployed: { version: 'a'.repeat(40), commit: null },
})
const configsOf = (s: SetupWorld) =>
  s.w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
const surface = (s: SetupWorld) =>
  [
    s.w.all(),
    s.settings() ?? '',
    ...s.w.wrangler.map((c) => c.args.join(' ')),
    ...s.w.wrangler.flatMap((c) => (c.configText ? [c.configText] : [])),
  ].join('\n')

describe('arguments (P1)', () => {
  it("takes setup:remote's flags with --secrets-file and --settings, and no --clerk-env-file", () => {
    const o = parseInstanceSetupArgs([
      '--env',
      'demo',
      '--auth',
      'clerk',
      '--api-host',
      API_HOST,
      '--owner-email',
      'o@x.invalid',
      '--settings',
      '/s/demo.json',
      '--secrets-file',
      '/s/demo.env',
      '--only',
      'migrate,deploy',
      '--rotate-secrets',
      '--no-dcr',
    ])
    expect(o.settingsPath).toBe('/s/demo.json')
    expect(o.secretsPath).toBe('/s/demo.env')
    expect(o.opts).toMatchObject({
      env: 'demo',
      apiHost: API_HOST,
      auth: 'clerk',
      workerName: 'vb-demo',
      d1Name: 'vb-crm-demo',
      r2Name: 'vb-bodies-demo',
      only: ['migrate', 'deploy'],
      rotateSecrets: true,
      noDcr: true,
    })
    expect(() => parseInstanceSetupArgs([...NONE_ARGS, '--clerk-env-file', '.env.demo'])).toThrow(/clerk-env-file/)
    expect(() => parseInstanceSetupArgs(['--api-host', API_HOST, '--auth', 'none'])).toThrow(/--env/)
    expect(() => parseInstanceSetupArgs([...NONE_ARGS, '--no-dcr'])).toThrow(/--auth clerk/)
  })
})

describe('fresh install, release mode', () => {
  it("runs D11's steps in order with the package's wrangler on a generated config, creates the settings file, and a second run changes nothing", async () => {
    const s = world({ sim: FRESH_SIM })
    expect(await run(s)).toBe(0)
    expect(s.w.err).toEqual([])
    expect(s.rows().map((r) => `${r.status} ${r.step}`)).toEqual([
      'ok preflight',
      'create config:resources',
      'create config:write',
      'update migrate',
      'create bootstrap',
      'update deploy',
      'ok secrets',
      'ok verify',
    ])
    // Every wrangler call is `<args> -c <generated config>`, no pnpm, git or --env, and the config is gone afterwards.
    for (const c of s.w.wrangler) {
      expect(c.args.at(-2)).toBe('-c')
      expect(c.configPath!.startsWith(s.w.tmpRoot)).toBe(true)
      expect(c.configText).not.toBeNull()
      expect(c.args).not.toContain('--env')
      expect(c.args.join(' ')).not.toMatch(/\b(pnpm|git)\b/)
    }
    expect(readdirSync(s.w.tmpRoot)).toEqual([])
    expect(s.writes().map((a) => a.slice(0, 3).join(' '))).toEqual([
      'd1 create vb-crm-demo',
      'd1 create vb-control-demo',
      'r2 bucket create',
      'd1 migrations apply',
      'd1 migrations apply',
      'deploy --no-bundle --var',
    ])
    const deploy = s.w.wrangler.find((c) => c.args[0] === 'deploy')!
    expect(deploy.args).toEqual(deployArgs('0.1.0', 'abc1234', deploy.configPath!))
    expect(s.sim.d1s).toHaveLength(2)
    expect(s.sim.opened).toHaveLength(1)
    const settings = loadSettings(s.w.settingsPath, 'demo')
    expect(settings).toEqual({
      version: 1,
      env: 'demo',
      worker: 'vb-demo',
      api_host: API_HOST,
      d1: { name: 'vb-crm-demo', id: s.sim.d1s[0]!.uuid },
      control_d1: { name: 'vb-control-demo', id: s.sim.d1s[1]!.uuid },
      r2_bucket: 'vb-bodies-demo',
      workflow: { name: 'vb-mail-sync-demo' },
      vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' },
    })

    // The second identical run: every step ok, zero writes, the file byte for byte the same.
    const before = s.settings()
    const calls = s.w.wrangler.length
    const out = s.w.out.length
    const opened = s.sim.opened.length
    expect(await run(s)).toBe(0)
    expect(
      s
        .rows()
        .slice(8)
        .map((r) => `${r.status} ${r.step}`),
    ).toEqual([
      'ok preflight',
      'ok config:resources',
      'ok config:write',
      'ok migrate',
      'ok bootstrap',
      'ok deploy',
      'ok secrets',
      'ok verify',
    ])
    expect(
      s.w.wrangler
        .slice(calls)
        .map((c) => c.args)
        .filter(isWrite),
    ).toEqual([])
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
  const fx = JSON.parse(readFileSync(new URL('./test/source-env-blocks.json', import.meta.url), 'utf8')) as Record<
    string,
    any
  >
  const pick = (c: Record<string, any>) => ({
    name: c.name,
    routes: c.routes,
    d1: { ...c.d1_databases[0], migrations_dir: undefined },
    r2_buckets: c.r2_buckets,
    vars: c.vars,
  })
  // An instance adopted from `vault-` names with no settings file yet: the names come from flags ([[OPS276]]; with a file, from the record).
  const ADOPT = ['--worker-name', 'vault-demo', '--d1-name', 'vault-demo', '--r2-name', 'vault-demo-bodies']
  const FLAGS = [...NONE_ARGS, ...ADOPT, '--web-origin', 'https://app.demo.invalid']

  it('adopts existing resources by name (the smoked1 shape): nothing created, the file written with the adopted id, the marker found', async () => {
    const s = world({ controlMarker: 'org-1', sim: ADOPTED() })
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
    expect(
      (
        parse(
          reconcileEnvBlock(text, {
            env: 'demo',
            workerName: 'vault-demo',
            d1Name: 'vault-demo',
            d1Id: UUID,
            r2Name: 'vault-demo-bodies',
            apiHost: API_HOST,
            corsOrigins: 'https://app.demo.invalid',
          }).text,
        ) as any
      ).env.demo,
    ).toEqual(fx.none)

    const none = world({ controlMarker: 'org-1', sim: ADOPTED() })
    expect(await run(none, FLAGS)).toBe(0)
    expect(pick(configsOf(none).at(-1)!)).toEqual(pick(fx.none))

    const clerk = world({
      controlMarker: 'org-1',
      sim: {
        ...ADOPTED(),
        marker: {
          organization_id: 'org-1',
          auth_provider: 'clerk',
          auth_org_id: 'https://acme-test-12.clerk.accounts.dev',
          organizations: 1,
        },
        clerk: makeClerk(),
      },
      secretsText: CLERK_SECRETS_TEXT,
    })
    expect(await run(clerk, [...CLERK_ARGS, ...ADOPT])).toBe(0)
    expect(pick(configsOf(clerk).at(-1)!)).toEqual(pick(fx.clerk))
    expect(loadSettings(clerk.w.settingsPath, 'demo').vars).toEqual(fx.clerk.vars)
  })

  it('a settings file whose host differs from --api-host is refused before any step (OPS308 D14: a host change needs --change-host), names the host and the flag, and stays unchanged', async () => {
    const s = world({
      controlMarker: 'org-1',
      sim: ADOPTED(),
      settings: noControlSettings({
        api_host: 'other.demo.invalid',
        control_d1: { name: 'vb-control-demo', id: CONTROL_UUID },
      }),
    })
    const before = s.settings()
    expect(await run(s)).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/other\.demo\.invalid/)
    expect(s.w.err.join('\n')).toMatch(/--change-host/)
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
    expect(s.w.err.join('\n')).toMatch(/^vibase-server setup: /)
    expect(s.writes()).toEqual([])
    expect(s.w.asked).toEqual([])
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
  it('OPS493 P3: the steps: line lists the selected steps in run order, in real and dry runs; --only and the auth mode filter it', async () => {
    const d = world()
    expect(await run(d, [...NONE_ARGS, '--dry-run'])).toBe(0)
    const line = d.w.out.find((l) => l.startsWith('steps: '))
    expect(line).toBe(`steps: ${STEP_NAMES.filter((n) => !CLERK_ONLY_STEPS.includes(n)).join(', ')}`)
    expect(d.w.out.indexOf(line!)).toBeGreaterThan(d.w.out.findIndex((l) => l.startsWith('setup: env')))
    await d1.reset()
    const o = world()
    expect(await run(o, [...NONE_ARGS, '--dry-run', '--only', 'preflight,config:resources'])).toBe(0)
    expect(o.w.out).toContain('steps: preflight, config:resources')
    await d1.reset()
    const r = world()
    expect(await run(r), r.w.all()).toBe(0)
    expect(r.w.out.find((l) => l.startsWith('steps: '))).toBe(line)
  })
  it('OPS493 D4: on a terminal `n` after the header and steps: exit 0, the abort line, no write call, no settings, no API write; the header precedes the question', async () => {
    const s = world({ answers: ['n'] })
    expect(await run(s)).toBe(0)
    expect(s.w.asked).toHaveLength(1)
    const before = s.w.out.slice(0, s.w.asked[0]!.out)
    expect(before.some((l) => l.startsWith('setup: env'))).toBe(true)
    expect(before.some((l) => l.startsWith('steps: '))).toBe(true)
    expect(s.w.out.slice(s.w.asked[0]!.out)).toEqual(['aborted: nothing was changed'])
    expect(s.w.wrangler).toHaveLength(0)
    expect(s.writes()).toEqual([])
    expect(s.settings()).toBeNull()
    expect(s.sim.opened).toEqual([])
    expect(s.sim.subdomain.puts).toEqual([])
    expect(
      s.w.fetchCalls.filter((c) => c.url.includes('api.cloudflare.com') && (c.init?.method ?? 'GET') !== 'GET'),
    ).toEqual([])
  })
  it('OPS493 D4: `y` runs the steps as a --yes run does; --yes, -y, --dry-run and no terminal never ask', async () => {
    const a = world({ answers: ['y'] })
    expect(await run(a), a.w.all()).toBe(0)
    expect(a.w.asked).toHaveLength(1)
    await d1.reset()
    const b = world({ terminal: false })
    expect(await run(b, [...NONE_ARGS, '--yes']), b.w.all()).toBe(0)
    expect(b.writes()).toEqual(a.writes())
    for (const argv of [
      [...NONE_ARGS, '-y'],
      [...NONE_ARGS, '--yes', '--dry-run'],
      [...NONE_ARGS, '--dry-run'],
    ]) {
      await d1.reset()
      const s = world({ answers: ['n'] })
      expect(await run(s, argv), s.w.all()).toBe(0)
      expect(s.w.asked, argv.join(' ')).toEqual([])
    }
    await d1.reset()
    const n = world({ terminal: false })
    expect(await run(n), n.w.all()).toBe(0)
    expect(n.w.asked).toEqual([])
    expect(n.writes().length).toBeGreaterThan(0)
  })
  it('OPS493 D1: CONFIRM_REMOTE=1 is no substitute for --yes: on a terminal it still asks, and `n` writes nothing', async () => {
    const s = world({ answers: ['n'], processEnv: { CONFIRM_REMOTE: '1' } })
    expect(await run(s)).toBe(0)
    expect(s.w.asked).toHaveLength(1)
    expect(s.w.out).toContain('aborted: nothing was changed')
    expect(s.w.wrangler).toHaveLength(0)
    expect(s.writes()).toEqual([])
  })
  it('OPS493 D1: CONFIRM_REMOTE unset is not a refusal', async () => {
    const s = world({ terminal: false, processEnv: {} })
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.w.all()).not.toMatch(/CONFIRM_REMOTE/)
  })
  it('worker "vb" in an existing settings file', async () => {
    const s = world({ settings: noControlSettings({ worker: 'vb' }) })
    refused(s, await run(s), /unknown env demo/, true)
    expect(s.w.wrangler).toHaveLength(0)
  })
  it('a wrangler that cannot be resolved (the refusal the real runner throws)', async () => {
    // A step's own refusal comes after the question (the first step runs the wrangler); no terminal here, so the matrix helper's "never asked" holds.
    const s = world({
      terminal: false,
      intercept: () => {
        throw new InstanceRefusal('cannot resolve the wrangler of the installed package at /x: not found: reinstall it')
      },
    })
    refused(s, await run(s), /cannot resolve the wrangler/)
  })
  it('a package whose wrangler cannot be resolved, through the real runner, refuses before any spawn', async () => {
    const s = world({})
    const outer = mkTmp('ops232-outer-')
    const pkgDir = join(outer, 'node_modules', 'vibase')
    cpSync(s.w.pkg.dir, pkgDir, { recursive: true })
    mkdirSync(join(outer, 'node_modules', 'wrangler'), { recursive: true })
    // The nearest `wrangler` has no bin: it cannot be run, and nothing is ever spawned (pnpm's NODE_PATH would otherwise find the repo's).
    writeFileSync(
      join(outer, 'node_modules', 'wrangler', 'package.json'),
      JSON.stringify({ name: 'wrangler', version: '0.0.0' }),
    )
    const out: string[] = []
    const err: string[] = []
    const code = await runInstance(
      ['setup', ...NONE_ARGS],
      {
        stdout: (t) => void out.push(t),
        stderr: (t) => void err.push(t),
        env: { XDG_CONFIG_HOME: s.w.config, PATH: process.env.PATH, HOME: s.w.deps.homedir },
      },
      pkgDir,
      { fetch: s.w.deps.fetch, now: s.w.deps.now, sleep: s.w.deps.sleep },
    )
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/vibase-server setup: .*wrangler/)
    expect(err.join('')).toContain(pkgDir)
    expect(existsSync(s.w.settingsPath)).toBe(false)
  })
  it('a live instance that is a newer semver than the package', async () => {
    const s = world({ sim: { deployed: { version: '9.9.9', commit: 'f'.repeat(7) } } })
    refused(s, await run(s), /9\.9\.9.*0\.1\.0|newer/)
    expect(s.w.err.join('\n')).toMatch(/vibase-server redeploy/)
    expect(s.w.wrangler).toHaveLength(0)
  })

  const failedAt = (s: SetupWorld, code: number, step: string) => {
    expect(code).toBe(3)
    const rows = s.rows()
    expect(rows.at(-1)).toMatchObject({ status: 'fail', step })
    expect(s.w.err.join('\n')).toMatch(new RegExp(`^vibase-server setup: ${step} failed`))
  }
  it('ahead at migrate: exit 3, nothing deployed', async () => {
    const s = world({
      controlMarker: 'org-1',
      sim: { ...ADOPTED(), applied: [...ALL_MIGRATIONS, '0003_from_the_future.sql'] },
    })
    failedAt(s, await run(s), 'migrate')
    expect(s.writes().filter((a) => a[0] === 'deploy' || a.includes('apply'))).toEqual([])
    expect(s.w.out.join('\n')).toMatch(/0003_from_the_future/)
  })
  it('the deploy fails: exit 3, no secrets and no verify', async () => {
    const s = world({ controlMarker: 'org-1', sim: { ...ADOPTED(), failDeploy: true } })
    failedAt(s, await run(s), 'deploy')
    expect(s.rows().map((r) => r.step)).not.toContain('secrets')
    expect(s.sim.bulk).toEqual([])
  })
  it('OPS496 D1: a deploy that never reaches the Worker fails verify at once at the Worker check, with no wait', async () => {
    const s = world({
      controlMarker: 'org-1',
      sim: { ...ADOPTED(), deployed: { version: '0.0.9', commit: null }, deployNoop: true },
    })
    failedAt(s, await run(s), 'verify')
    expect(s.rows().find((r) => r.step === 'verify')!.detail).toMatch(/Worker check failed: VERSION is 0\.0\.9/)
    expect(s.w.clock.t).toBe(0)
  })
  it('OPS240 P1: prints the package line as vibase-server/<version> (<commit>), <n> files verified, before the first step', async () => {
    const s = world({ processEnv: {} })
    expect(await run(s, [...NONE_ARGS, '--dry-run'])).toBe(0)
    expect(s.w.out[0]).toBe(packageLine(s.w.pkg.dir))
    expect(s.w.out.join('\n')).not.toMatch(/package: vibase /)
  })
  it('--dry-run exits 0 and writes nothing: no resource, no settings file, no deploy, no D1', async () => {
    const s = world({ processEnv: {} })
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
  const OPERATOR = [
    ...NONE_ARGS,
    '--worker-name',
    'vault-demo',
    '--d1-name',
    'vault-demo',
    '--r2-name',
    'vault-demo-bodies',
    '--owner-email',
    'owner@example.com',
    '--operator-agent',
    'operator',
    '--key-env',
    'DEMO_KEY',
  ]
  const count = async (table: string) =>
    ((await d1.d1.prepare(`select count(*) as n from ${table}`).first()) as { n: number }).n

  it('opens the generated config with remoteBindings and no persistence, and writes the marker, the organisation and the operator key to the secrets file', async () => {
    const s = world({ sim: { ...ADOPTED(), marker: null } })
    expect(await run(s, OPERATOR)).toBe(0)
    expect(s.sim.opened).toHaveLength(1)
    const { opts, configText } = s.sim.opened[0]!
    expect(opts).toMatchObject({ remoteBindings: true, persist: false })
    expect(opts.configPath.startsWith(s.w.tmpRoot)).toBe(true)
    expect(opts.env).toMatchObject({ CLOUDFLARE_API_TOKEN: TOKEN })
    expect(JSON.parse(configText!).d1_databases[0]).toMatchObject({ database_id: UUID, remote: true })
    expect((await d1.d1.prepare('select auth_provider, auth_org_id from deployment').first()) as any).toEqual({
      auth_provider: 'none',
      auth_org_id: 'demo',
    })
    expect(await count('organizations')).toBe(1)
    // [[CORE356]]: the operator key is minted on the control plane, with its audit row, and none in the CRM database.
    expect(s.control.keys).toHaveLength(1)
    expect(s.control.audit).toHaveLength(1)
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
    expect((await d1.d1.prepare('select auth_provider, auth_org_id from deployment').first()) as any).toEqual({
      auth_provider: 'clerk',
      auth_org_id: 'https://acme-test-12.clerk.accounts.dev',
    })
    expect(await count('organizations')).toBe(1)
    expect(await count('users')).toBe(0)
    expect(s.rows().find((r) => r.step === 'clerk')).toBeTruthy()
    // OPS496 D3, D5: Clerk's discovery is read once, and Clerk prints no owner block.
    expect(s.w.fetchUrls.filter((u) => u === `https://${API_HOST}/.well-known/vibase`)).toHaveLength(1)
    expect(s.w.out.join('\n')).not.toMatch(/Claim your instance|No owner invitation/)
  })

  it('a --key-env already in the secrets file refuses before any D1 write and leaves the file alone', async () => {
    const s = world({
      sim: { ...ADOPTED(), marker: null },
      secretsText: `CLOUDFLARE_ACCOUNT_ID=a-0000\nCLOUDFLARE_API_TOKEN=${TOKEN}\nDEMO_KEY=already-here-1234\n`,
    })
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
    expect(Object.keys(JSON.parse(bulk[0]!.input!)).sort()).toEqual([
      'CLERK_JWT_KEY',
      'CLERK_SECRET_KEY',
      'CREDENTIALS_KEY',
      'GOOGLE_CLIENT_SECRET',
      'OAUTH_STATE_SECRET',
    ])
    for (const c of s.w.wrangler) if (c !== bulk[0]) expect(c.input).toBeUndefined()
    const seen = surface(s)
    for (const v of secretValues) expect(seen.includes(v), `a secret value reached the surface`).toBe(false)
    expect(
      s.w.fetchCalls
        .map((f) => f.url)
        .join('\n')
        .includes(CLERK_SECRET_VALUES[0]!),
    ).toBe(false)
    // Public values travel into the settings file; secrets do not.
    const settings = JSON.parse(s.settings()!)
    expect(settings.vars.GOOGLE_CLIENT_ID).toBe('gid-123.apps.googleusercontent.com')
    for (const v of CLERK_SECRET_VALUES) expect(JSON.stringify(settings).includes(v)).toBe(false)
  })

  it('a failing wrangler that echoes its whole environment leaks nothing into the output', async () => {
    const s = world({
      controlMarker: 'o',
      sim: {
        ...ADOPTED(),
        failDeploy: true,
        clerk: makeClerk(),
        marker: {
          organization_id: 'o',
          auth_provider: 'clerk',
          auth_org_id: 'https://acme-test-12.clerk.accounts.dev',
          organizations: 1,
        },
      },
      secretsText: CLERK_SECRETS_TEXT,
    })
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
      expect(text, f).not.toMatch(
        /ROOT_ENV_PATH|loadRootEnv|env-file\.js|readEnvText|loadEnvFile|process\.env|REPO_ROOT|CONFIG_PATH/,
      )
    }
  })
})

describe('the instance entry', () => {
  it('lists setup in the help', async () => {
    const { INSTANCE_HELP } = await import('./main.js')
    expect(INSTANCE_HELP).toContain('vibase-server setup --env <name> [--api-host <host> | --workers-dev]')
    expect(INSTANCE_HELP).toMatch(/--secrets-file/)
    expect(INSTANCE_HELP).toMatch(
      /Exit 0: done, or the dry run is complete; 2: refused before the first step; 3: a step failed/,
    )
  })
  it('setup with an empty config home and no Cloudflare values refuses at the secrets path (real deps, before any network call)', async () => {
    const xdg = mkTmp()
    const err: string[] = []
    const s = world({})
    const code = await runInstance(
      ['setup', ...NONE_ARGS],
      { stdout: () => {}, stderr: (t) => void err.push(t), env: { XDG_CONFIG_HOME: xdg, PATH: process.env.PATH } },
      s.w.pkg.dir,
    )
    expect(code).toBe(2)
    expect(err.join('')).toContain(join(xdg, 'vibase', 'instances', 'demo.env'))
  })
})
