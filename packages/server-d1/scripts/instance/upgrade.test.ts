import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runUpgrade } from './upgrade.js'
import { ACCOUNT, captureHealthBody, cleanup, makeWorld, NO_TRACKER_JSON, packageLine, TOKEN, trackerJson, validSettings, type World, type WorldOptions } from './test-kit.js'

afterEach(cleanup)
let HEALTH: Record<string, any>
beforeAll(async () => { HEALTH = await captureHealthBody() }, 60_000)

const PKG_VERSION = '0.1.0'
const ALL = ['0001_a.sql', '0002_b.sql']

interface Sim {
  /** `null`: no tracker table. */
  applied: string[] | null
  version: string
  /** Health polls (after the deploy) answered with the old version before the new one shows. */
  lag: number
  failApply?: boolean
  failDeploy?: boolean
  /** `apply` succeeds but does not change the tracker. */
  applyNoop?: boolean
  /** The tracker answer after `apply` (instead of the real state). */
  trackerAfterApply?: string
  /** Deploy succeeds but the version never changes. */
  deployNoop?: boolean
  /** Replace a keyless check's answer: path -> [status, body] for requests without a key. */
  smoke?: Record<string, [number, unknown]>
  applyRan: boolean
  deployed: boolean
}
const sim = (over: Partial<Sim> = {}): Sim => ({ applied: [], version: '0.0.9', lag: 0, applyRan: false, deployed: false, ...over })

const migrationsStatus = (applied: string[] | null): string => {
  const have = applied ?? []
  if (applied === null) return 'unknown'
  if (ALL.some((n) => !have.includes(n))) return 'behind'
  return have.length > ALL.length ? 'ahead' : 'current'
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function worldFor(s: Sim, o: WorldOptions & { runner?: WorldOptions['runner'] } = {}): World {
  let polls = 0
  return makeWorld({
    processEnv: { CONFIRM_REMOTE: '1' },
    ...o,
    fetch: (url) => {
      const path = new URL(url).pathname
      if (path === '/health') {
        if (s.deployed) polls++
        const shown = s.deployed && polls > s.lag ? s.version : s.deployed && s.lag > 0 ? '0.0.9' : s.version
        return json(200, { ...HEALTH, initialised: true, version: shown, migrations: { ...HEALTH.migrations, status: migrationsStatus(s.applied) } })
      }
      const override = s.smoke?.[path]
      if (override) return json(override[0], override[1])
      if (path === '/openapi.json') return json(404, { error: { code: 'not_found', message: 'not found' } })
      return json(401, { error: { code: 'unauthorized', message: 'unauthorized' } })
    },
    runner:
      o.runner ??
      ((args, _env) => {
        const sub = args.slice(0, 3).join(' ')
        if (sub.startsWith('d1 execute')) {
          if (s.applyRan && s.trackerAfterApply !== undefined) return { status: 0, stdout: s.trackerAfterApply, stderr: '' }
          return s.applied === null ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' } : { status: 0, stdout: trackerJson(s.applied), stderr: '' }
        }
        if (sub.startsWith('d1 migrations apply')) {
          s.applyRan = true
          if (s.failApply) return { status: 1, stdout: '', stderr: 'apply blew up' }
          if (!s.applyNoop) s.applied = [...ALL]
          return { status: 0, stdout: 'applied', stderr: '' }
        }
        if (sub.startsWith('deploy')) {
          if (s.failDeploy) return { status: 1, stdout: '', stderr: 'deploy blew up' }
          s.deployed = true
          if (!s.deployNoop) s.version = PKG_VERSION
          return { status: 0, stdout: 'deployed', stderr: '' }
        }
        return { status: 1, stdout: '', stderr: `unexpected wrangler call ${args.join(' ')}` }
      }),
  })
}

const run = async (s: Sim, argv: string[] = ['--env', 'demo'], o: WorldOptions = {}) => {
  const w = worldFor(s, o)
  return { w, s, code: await runUpgrade(argv, w.deps) }
}
const verbs = (w: World) => w.wrangler.map((c) => c.args.slice(0, c.args[0] === 'd1' ? 3 : 1).join(' '))
const writes = (w: World) => verbs(w).filter((v) => !v.startsWith('d1 execute'))
const noTemp = (w: World) => expect(readdirSync(w.tmpRoot)).toEqual([])

describe('D15 upgrade sequence and guards', () => {
  it('a behind instance: migrate apply, tracker read, deploy, each on the generated config, then verify and the keyless smoke; exit 0', async () => {
    const { w, code } = await run(sim({ applied: ['0001_a.sql'] }))
    expect(w.err).toEqual([])
    expect(code).toBe(0)
    expect(verbs(w)).toEqual(['d1 execute DB', 'd1 migrations apply', 'd1 execute DB', 'deploy'])
    for (const c of w.wrangler) {
      expect(c.args).toContain('-c')
      expect(c.args).not.toContain('--env')
      expect(c.configPath).toMatch(/vibase-instance-.*wrangler\.jsonc$/)
    }
    const apply = w.wrangler[1]!.args
    expect(apply).toEqual(['d1', 'migrations', 'apply', 'DB', '--remote', '-c', w.wrangler[1]!.configPath])
    const deploy = w.wrangler[3]!.args
    expect(deploy).toContain('--no-bundle')
    expect(deploy.join(' ')).toContain(`--var VERSION:${PKG_VERSION}`)
    expect(deploy.join(' ')).toMatch(/--var COMMIT:\S+/)
    // verify and the keyless smoke saw the fake fetch
    const paths = w.fetchCalls.map((c) => new URL(c.url).pathname)
    expect(paths).toContain('/openapi.json')
    expect(paths.filter((p) => p === '/api/v1/tasks')).toHaveLength(3)
    expect(w.out.join('\n')).toMatch(/0\.0\.9 -> package 0\.1\.0|live 0\.0\.9.*0\.1\.0/)
    expect(w.out.join('\n')).toMatch(/0002_b\.sql/)
    noTemp(w)
  })

  it('verify polls (injected clock) until the new version shows', async () => {
    const { w, code } = await run(sim({ lag: 2 }))
    expect(code).toBe(0)
    expect(w.clock.t).toBeGreaterThanOrEqual(10_000)
    expect(w.clock.t).toBeLessThan(300_000)
  })

  it('--dry-run prints the plan, runs only the gate reads, needs no CONFIRM_REMOTE; exit 0', async () => {
    const { w, code } = await run(sim(), ['--env', 'demo', '--dry-run'], { processEnv: {} })
    expect(code).toBe(0)
    expect(verbs(w)).toEqual(['d1 execute DB'])
    expect(w.out.join('\n')).toMatch(/0001_a\.sql/)
    expect(w.out.join('\n')).toMatch(/dry run/i)
    noTemp(w)
  })

  it('OPS240 P1: prints the package line as vibase-server/<version> (<commit>), <n> files verified, before the plan', async () => {
    const { w } = await run(sim(), ['--env', 'demo', '--dry-run'], { processEnv: {} })
    expect(w.out[0]).toBe(packageLine(w.pkg.dir))
    expect(w.out.join('\n')).not.toMatch(/package: vibase /)
  })

  it('without CONFIRM_REMOTE it refuses after the plan with zero write calls; exit 2', async () => {
    const { w, code } = await run(sim(), ['--env', 'demo'], { processEnv: {} })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/vibase-server upgrade: .*CONFIRM_REMOTE=1/)
    expect(w.out.join('\n')).toMatch(/0001_a\.sql/)
    expect(writes(w)).toEqual([])
    noTemp(w)
  })

  it('CONFIRM_REMOTE must be exactly 1', async () => {
    const { w, code } = await run(sim(), ['--env', 'demo'], { processEnv: { CONFIRM_REMOTE: 'yes' } })
    expect(code).toBe(2)
    expect(writes(w)).toEqual([])
  })

  it('nothing to do (same version, migrations current): exit 0, no write, no CONFIRM_REMOTE, even with --dry-run', async () => {
    for (const argv of [['--env', 'demo'], ['--env', 'demo', '--dry-run']]) {
      const { w, code } = await run(sim({ applied: [...ALL], version: PKG_VERSION }), argv, { processEnv: {} })
      expect(code).toBe(0)
      expect(verbs(w)).toEqual(['d1 execute DB'])
      expect(w.out.join('\n')).toMatch(/nothing to do/)
      expect(w.fetchCalls.map((c) => new URL(c.url).pathname)).toEqual(['/health'])
    }
  })

  it('same version but a pending migration is not nothing to do: it migrates and deploys', async () => {
    const { w, code } = await run(sim({ applied: ['0001_a.sql'], version: PKG_VERSION }))
    expect(code).toBe(0)
    expect(writes(w)).toEqual(['d1 migrations apply', 'deploy'])
  })

  it('arguments: --env is required, unknown flags refuse; exit 2 before any call', async () => {
    for (const argv of [[], ['--env', 'demo', '--bogus'], ['--env', 'Bad_Name']]) {
      const { w, code } = await run(sim(), argv)
      expect(code).toBe(2)
      expect(w.err.join('\n')).toMatch(/vibase-server upgrade:/)
      expect(w.fetchUrls).toEqual([])
      expect(w.wrangler).toEqual([])
    }
  })
})

describe('D15 failure stops (exit 3, the step named, no later write)', () => {
  const failed = (w: World, code: number, step: RegExp) => {
    expect(code).toBe(3)
    expect(w.err.join('\n')).toMatch(/vibase-server upgrade: .*partly upgraded/)
    expect(w.err.join('\n')).toMatch(step)
    noTemp(w)
  }
  it('migrate apply fails: no tracker read after, no deploy', async () => {
    const { w, code } = await run(sim({ failApply: true }))
    failed(w, code, /migrate/)
    expect(verbs(w)).toEqual(['d1 execute DB', 'd1 migrations apply'])
  })
  it('the post-migrate tracker read is behind: no deploy', async () => {
    const { w, code } = await run(sim({ applyNoop: true, applied: ['0001_a.sql'] }))
    failed(w, code, /tracker/)
    expect(verbs(w)).not.toContain('deploy')
    expect(verbs(w)).toEqual(['d1 execute DB', 'd1 migrations apply', 'd1 execute DB'])
  })
  it('the post-migrate tracker read is unknown (no tracker table): no deploy', async () => {
    const { w, code } = await run(sim({ trackerAfterApply: NO_TRACKER_JSON }))
    failed(w, code, /tracker/)
    expect(verbs(w)).not.toContain('deploy')
  })
  it('the post-migrate tracker read is unreadable: no deploy', async () => {
    const { w, code } = await run(sim({ trackerAfterApply: 'not json at all' }))
    failed(w, code, /tracker/)
    expect(verbs(w)).not.toContain('deploy')
  })
  it('deploy fails: nothing is verified or smoked', async () => {
    const { w, code } = await run(sim({ failDeploy: true }))
    failed(w, code, /deploy/)
    expect(w.fetchCalls.map((c) => new URL(c.url).pathname)).toEqual(['/health']) // the gate's only
  })
  it('verify never sees the version: bounded at 300 s on the injected clock, then fails; no smoke', async () => {
    const { w, code } = await run(sim({ deployNoop: true }))
    failed(w, code, /verify/)
    expect(w.clock.t).toBeGreaterThanOrEqual(300_000)
    expect(w.clock.t).toBeLessThan(320_000)
    expect(w.fetchCalls.some((c) => new URL(c.url).pathname === '/openapi.json')).toBe(false)
  })
  it('one smoke check fails: exit 3 naming the check', async () => {
    const { w, code } = await run(sim({ smoke: { '/openapi.json': [200, {}] } }))
    failed(w, code, /smoke.*openapi\.json/s)
  })
  it('a smoke 401 check that gets 200 fails', async () => {
    const { w, code } = await run(sim({ smoke: { '/api/v1/tasks': [200, { data: [] }] } }))
    failed(w, code, /smoke/)
  })
})

describe('D16 rollback (P3)', () => {
  const NEWER = [...ALL, '0003_c.sql']
  const rollback = ['--env', 'demo', '--rollback']
  it('a newer live semver: deploy only, no d1 migrations call, the schema warning, verify accepts ahead; exit 0', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: '0.2.0' }), rollback)
    expect(w.err).toEqual([])
    expect(code).toBe(0)
    expect(verbs(w)).toEqual(['d1 execute DB', 'deploy'])
    expect(w.wrangler.some((c) => c.args.includes('migrations'))).toBe(false)
    expect(w.out.join('\n')).toMatch(/database stays at its newer schema/)
    expect(w.wrangler[1]!.args).toContain('--no-bundle')
    expect(w.out.join('\n')).toMatch(/rollback/i)
    noTemp(w)
  })
  it('--rollback --dry-run prints the plan and writes nothing', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: '0.2.0' }), [...rollback, '--dry-run'], { processEnv: {} })
    expect(code).toBe(0)
    expect(writes(w)).toEqual([])
  })
  it('--rollback without CONFIRM_REMOTE refuses with no write', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: '0.2.0' }), rollback, { processEnv: {} })
    expect(code).toBe(2)
    expect(writes(w)).toEqual([])
  })
  it('refuses when the package has migrations the database lacks (a rollback cannot add migrations)', async () => {
    const { w, code } = await run(sim({ applied: ['0001_a.sql'], version: '0.2.0' }), rollback)
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/0002_b\.sql/)
    expect(w.err.join('\n')).toMatch(/upgrade/)
    expect(writes(w)).toEqual([])
  })
  it('refuses with no tracker table at all', async () => {
    const { w, code } = await run(sim({ applied: null, version: '0.2.0' }), rollback)
    expect(code).toBe(2)
    expect(writes(w)).toEqual([])
  })
  it('refuses an equal live version, pointing to upgrade', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: PKG_VERSION }), rollback)
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/upgrade/)
    expect(writes(w)).toEqual([])
  })
  it('refuses an older live version, pointing to upgrade', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: '0.0.9' }), rollback)
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/upgrade/)
    expect(writes(w)).toEqual([])
  })
  it('a non-semver live version proceeds with the note', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: 'dev' }), rollback)
    expect(code).toBe(0)
    expect(w.out.join('\n')).toMatch(/dev.*not a release version/)
    expect(writes(w)).toEqual(['deploy'])
  })
  it('a tampered installed file refuses before any call', async () => {
    const w = worldFor(sim({ applied: NEWER, version: '0.2.0' }))
    writeFileSync(join(w.pkg.dir, 'worker', 'worker.js'), '// tampered')
    expect(await runUpgrade(rollback, w.deps)).toBe(2)
    expect(w.err.join('\n')).toMatch(/worker\/worker\.js/)
    expect(w.fetchUrls).toEqual([])
    expect(w.wrangler).toEqual([])
  })
  it('without --rollback a newer live version still refuses', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: '0.2.0' }))
    expect(code).toBe(2)
    expect(writes(w)).toEqual([])
  })
  it('plain upgrade on a database with a migration the release lacks still refuses (D14 d), even with an older live version', async () => {
    const { code } = await run(sim({ applied: NEWER, version: '0.0.9' }))
    expect(code).toBe(2)
  })
  it('verify after a rollback fails if the version does not change', async () => {
    const { w, code } = await run(sim({ applied: NEWER, version: '0.2.0', deployNoop: true }), rollback)
    expect(code).toBe(3)
    expect(w.err.join('\n')).toMatch(/verify/)
  })
})

describe('D13 pinning and the installed package', () => {
  it('the generated config the deploy saw points inside the package; nothing but https://<api_host>/ is fetched', async () => {
    const { w } = await run(sim())
    const deploy = w.wrangler.find((c) => c.args[0] === 'deploy')!
    const cfg = JSON.parse(deploy.configText!) as Record<string, any>
    expect(cfg.main.startsWith(`${w.pkg.dir}/`)).toBe(true)
    expect(cfg.assets.directory.startsWith(`${w.pkg.dir}/`)).toBe(true)
    expect(cfg.d1_databases[0].migrations_dir.startsWith(`${w.pkg.dir}/`)).toBe(true)
    expect(cfg.d1_databases[0].remote).toBe(true)
    expect(cfg.vars).toEqual({ AUTH_PROVIDER: '' })
    expect(w.fetchUrls.length).toBeGreaterThan(3)
    for (const u of w.fetchUrls) expect(u.startsWith('https://api.demo.invalid/')).toBe(true)
    // wrangler is only ever told the package's version, never a download
    expect(w.wrangler.every((c) => !c.args.some((a) => /^https?:/.test(a)))).toBe(true)
  })
  it('the temp directory is gone after success and after a failure at each step', async () => {
    const cases: Partial<Sim>[] = [{}, { failApply: true }, { applyNoop: true }, { failDeploy: true }, { deployNoop: true }, { smoke: { '/openapi.json': [200, {}] } }]
    for (const c of cases) {
      const { w } = await run(sim(c))
      noTemp(w)
    }
  })
})

describe('secrets and side effects', () => {
  const leaks = (w: World) => {
    const text = w.all()
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(ACCOUNT)
    for (const c of w.wrangler) {
      expect(c.configText ?? '').not.toContain(TOKEN)
      expect(c.configText ?? '').not.toContain(ACCOUNT)
      expect(c.args.join(' ')).not.toContain(TOKEN)
    }
  }
  const echoing = (failOn: string): WorldOptions['runner'] => (args, env) => {
    const echo = { status: 1, stdout: JSON.stringify(env), stderr: `failed with env ${JSON.stringify(env)} token=${env.CLOUDFLARE_API_TOKEN}` }
    if (args.slice(0, 3).join(' ').startsWith(failOn)) return echo
    if (args[0] === 'd1' && args[1] === 'execute') return { status: 0, stdout: trackerJson(['0001_a.sql']), stderr: '' }
    return { status: 0, stdout: 'ok', stderr: '' }
  }
  it('a failing migrate or deploy that echoes its whole env prints no secret', async () => {
    for (const on of ['d1 migrations apply', 'deploy']) {
      const { w, code } = await run(sim({ applied: ['0001_a.sql'] }), ['--env', 'demo'], { runner: echoing(on) })
      expect(code).toBe(3)
      leaks(w)
      noTemp(w)
    }
  })
  it('the wrangler child gets the allow-listed environment only, on every call', async () => {
    const { w } = await run(sim(), ['--env', 'demo'], { processEnv: { CONFIRM_REMOTE: '1', CLERK_SECRET_KEY: 'sk_live_nope' } })
    for (const c of w.wrangler) expect(Object.keys(c.env).sort()).toEqual(['CI', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HOME', 'PATH', 'WRANGLER_SEND_METRICS'])
    leaks(w)
  })
  it('no secret appears in output, refusal or the generated config across every upgrade and rollback case', async () => {
    const cases: [Partial<Sim>, string[]][] = [
      [{}, ['--env', 'demo']],
      [{ failApply: true }, ['--env', 'demo']],
      [{ applied: [...ALL, '0003_c.sql'], version: '0.2.0' }, ['--env', 'demo', '--rollback']],
    ]
    for (const [c, argv] of cases) {
      const { w } = await run(sim(c), argv)
      leaks(w)
    }
  })
  it('the runner never sees secret, versions, a Clerk or a bootstrap call; every request is a GET with no key', async () => {
    const all: World[] = []
    const cases: [Partial<Sim>, string[]][] = [
      [{}, ['--env', 'demo']],
      [{ applied: [...ALL, '0003_c.sql'], version: '0.2.0' }, ['--env', 'demo', '--rollback']],
      [{ failDeploy: true }, ['--env', 'demo']],
    ]
    for (const [c, argv] of cases) all.push((await run(sim(c), argv)).w)
    for (const w of all) {
      for (const c of w.wrangler) {
        expect(c.args).not.toContain('secret')
        expect(c.args).not.toContain('versions')
        expect(c.args.join(' ')).not.toMatch(/clerk|bootstrap/i)
        expect(['d1', 'deploy']).toContain(c.args[0])
      }
      for (const f of w.fetchCalls) {
        expect((f.init?.method ?? 'GET').toUpperCase()).toBe('GET')
        expect(f.init?.body).toBeUndefined()
        const auth = (f.init?.headers as Record<string, string> | undefined)?.authorization
        if (auth !== undefined) expect(['Bearer vk_malformed', 'Bearer a.b.c']).toContain(auth)
      }
    }
  })
  it('the keyless smoke sends no Authorization, then the two malformed ones', async () => {
    const { w } = await run(sim())
    const tasks = w.fetchCalls.filter((c) => new URL(c.url).pathname === '/api/v1/tasks').map((c) => (c.init?.headers as Record<string, string> | undefined)?.authorization)
    expect(tasks).toEqual([undefined, 'Bearer vk_malformed', 'Bearer a.b.c'])
  })
})

describe('P4 refusal mapping', () => {
  it('worker "vb" in the settings file exits 2 with resolveTarget\'s message', async () => {
    const { w, code } = await run(sim(), ['--env', 'demo'], { settings: validSettings({ worker: 'vb' }) })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/vibase-server upgrade: unknown env demo/)
    expect(writes(w)).toEqual([])
    noTemp(w)
  })
})
