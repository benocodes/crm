// [[OPS487]]: `vibase-server redeploy`, and `upgrade` and `status` that tell builds apart. Everything runs against the fake wrangler runner and the fake `fetch` of the kit:
// no network, no Cloudflare. The failure-stop and secrets groups run for both modes (P2): a hand-written second sequence would be a finding.
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { statusOf } from '../remote.js'
import { runStatus } from './status.js'
import { runRedeploy, runUpgrade } from './upgrade.js'
import {
  ACCOUNT,
  bindingOf,
  CONTROL_ALL,
  captureHealthBody,
  cleanup,
  makeWorld,
  NO_TRACKER_JSON,
  PKG_COMMIT,
  TOKEN,
  trackerJson,
  type World,
  type WorldOptions,
} from './test-kit.js'

afterEach(cleanup)
let HEALTH: Record<string, any>
beforeAll(async () => {
  HEALTH = await captureHealthBody()
}, 60_000)

const PKG_VERSION = '0.1.0'
const ALL = ['0001_a.sql', '0002_b.sql']
const NOTE = 'note: rolling back code; the database schema is newer than this build and is not reversed'
const FULL_SHA = `${PKG_COMMIT}f0e1d2c3b4a59687766554433221100ffeeddcc`.slice(0, 40)

type Live = { version: string; commit: string | null }
interface Sim {
  control: string[] | null
  crm: string[] | null
  /** What `/health` answers before the deploy. */
  live: Live
  /** Health polls after the deploy that still answer `live` before the package's build shows. */
  lag: number
  failControlApply?: boolean
  failCrmApply?: boolean
  controlApplyNoop?: boolean
  crmApplyNoop?: boolean
  /** The CRM tracker answer after its `apply` (instead of the real state). */
  crmTrackerAfterApply?: string
  failDeploy?: boolean
  /** The deploy succeeds but `/health` keeps answering `live`. */
  neverSwitch?: boolean
  /** After the deploy `/health` shows the package's version but no commit at all. */
  noCommitAfter?: boolean
  smoke?: Record<string, [number, unknown]>
  /** `/health` does not answer at all. */
  unreachable?: boolean
  crmApplied: boolean
  deployed: boolean
}
const sim = (over: Partial<Sim> = {}): Sim => ({
  control: [...CONTROL_ALL],
  crm: [...ALL],
  live: { version: '0.0.9', commit: '1111111' },
  lag: 0,
  crmApplied: false,
  deployed: false,
  ...over,
})
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function worldFor(s: Sim, o: WorldOptions = {}): World {
  let polls = 0
  return makeWorld({
    processEnv: { CONFIRM_REMOTE: '1' },
    ...o,
    fetch: (url) => {
      const path = new URL(url).pathname
      if (path === '/health') {
        if (s.unreachable) throw new Error('getaddrinfo ENOTFOUND')
        if (s.deployed) polls++
        const switched = s.deployed && !s.neverSwitch && polls > s.lag
        const shown: Live = switched ? { version: PKG_VERSION, commit: s.noCommitAfter ? null : PKG_COMMIT } : s.live
        const { commit: _c, ...rest } = HEALTH
        return json(200, {
          ...rest,
          ...(shown.commit === null ? {} : { commit: shown.commit }),
          initialised: true,
          version: shown.version,
          migrations: { ...HEALTH.migrations, status: statusOf(s.crm, ALL) },
        })
      }
      const override = s.smoke?.[path]
      if (override) return json(override[0], override[1])
      if (path === '/openapi.json') return json(404, { error: { code: 'not_found', message: 'not found' } })
      return json(401, { error: { code: 'unauthorized', message: 'unauthorized' } })
    },
    runner:
      o.runner ??
      ((args) => {
        const b = bindingOf(args)
        const sub = args.slice(0, 3).join(' ')
        if (sub.startsWith('d1 execute')) {
          if (b === 'CONTROL_DB')
            return s.control === null
              ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' }
              : { status: 0, stdout: trackerJson(s.control), stderr: '' }
          if (s.crmApplied && s.crmTrackerAfterApply !== undefined)
            return { status: 0, stdout: s.crmTrackerAfterApply, stderr: '' }
          return s.crm === null
            ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' }
            : { status: 0, stdout: trackerJson(s.crm), stderr: '' }
        }
        if (sub.startsWith('d1 migrations apply')) {
          if (b === 'CONTROL_DB') {
            if (s.failControlApply) return { status: 1, stdout: '', stderr: 'control apply blew up' }
            if (!s.controlApplyNoop)
              s.control = [...(s.control ?? []), ...CONTROL_ALL.filter((n) => !(s.control ?? []).includes(n))]
            return { status: 0, stdout: 'applied', stderr: '' }
          }
          s.crmApplied = true
          if (s.failCrmApply) return { status: 1, stdout: '', stderr: 'apply blew up' }
          if (!s.crmApplyNoop) s.crm = [...(s.crm ?? []), ...ALL.filter((n) => !(s.crm ?? []).includes(n))]
          return { status: 0, stdout: 'applied', stderr: '' }
        }
        if (sub.startsWith('deploy')) {
          if (s.failDeploy) return { status: 1, stdout: '', stderr: 'deploy blew up' }
          s.deployed = true
          return { status: 0, stdout: 'deployed', stderr: '' }
        }
        return { status: 1, stdout: '', stderr: `unexpected wrangler call ${args.join(' ')}` }
      }),
  })
}

type Mode = 'upgrade' | 'redeploy'
const runners = { upgrade: runUpgrade, redeploy: runRedeploy }
const run = async (mode: Mode, s: Sim, extra: string[] = [], o: WorldOptions = {}) => {
  const w = worldFor(s, o)
  return { w, s, code: await runners[mode](['--env', 'demo', ...extra], w.deps) }
}
const step = (c: { args: string[] }) =>
  c.args[0] === 'deploy' ? 'deploy' : `${c.args[1] === 'migrations' ? 'apply' : 'read'}:${bindingOf(c.args)}`
const steps = (w: World) => w.wrangler.map(step)
const writes = (w: World) => steps(w).filter((x) => !x.startsWith('read:'))
const noTemp = (w: World) => expect(readdirSync(w.tmpRoot)).toEqual([])
const noteCount = (w: World) => w.out.filter((l) => l === NOTE).length
const URL_PATHS = (w: World) => w.fetchCalls.map((c) => new URL(c.url).pathname)

describe('OPS487 D1/D2 redeploy sequence', () => {
  const READS = ['read:CONTROL_DB', 'read:DB']
  const redeploys: [string, Partial<Sim>][] = [
    ['same version, a different commit', { live: { version: PKG_VERSION, commit: '1111111' } }],
    ['same version, the same commit', { live: { version: PKG_VERSION, commit: PKG_COMMIT } }],
    ['an older package over a newer live version', { live: { version: '0.2.0', commit: '2222222' } }],
  ]
  for (const [name, over] of redeploys) {
    it(`${name}, every migration already applied: the write log is exactly deploy (no d1 migrations call); exit 0`, async () => {
      const { w, code } = await run('redeploy', sim(over))
      expect(w.err).toEqual([])
      expect(code).toBe(0)
      expect(steps(w)).toEqual([...READS, 'deploy'])
      expect(w.wrangler.some((c) => c.args.includes('migrations'))).toBe(false)
      const deploy = w.wrangler.at(-1)!.args
      expect(deploy).toContain('--no-bundle')
      expect(deploy.join(' ')).toContain(`--var VERSION:${PKG_VERSION}`)
      expect(deploy.join(' ')).toContain(`--var COMMIT:${PKG_COMMIT}`)
      expect(w.out.join('\n')).toMatch(/redeployed demo to 0\.1\.0/)
      noTemp(w)
    })
  }
  it('the plan line names both builds (P1): live <version> (<commit>) -> package <version> (<commit>)', async () => {
    const { w } = await run('redeploy', sim({ live: { version: PKG_VERSION, commit: '1111111' } }), ['--dry-run'])
    expect(w.out).toContain(`plan: redeploy, live 0.1.0 (1111111) -> package ${PKG_VERSION} (${PKG_COMMIT})`)
  })
  it('a live /health with no commit prints (unknown) in the plan line', async () => {
    const { w } = await run('redeploy', sim({ live: { version: PKG_VERSION, commit: null } }), ['--dry-run'])
    expect(w.out).toContain(`plan: redeploy, live 0.1.0 (unknown) -> package ${PKG_VERSION} (${PKG_COMMIT})`)
  })
  it('pending migrations in the CRM only: migrate, tracker read for that database, then deploy', async () => {
    const { w, code } = await run(
      'redeploy',
      sim({ crm: ['0001_a.sql'], live: { version: PKG_VERSION, commit: '1111111' } }),
    )
    expect(code).toBe(0)
    expect(steps(w)).toEqual([...READS, 'apply:DB', 'read:DB', 'deploy'])
    expect(w.out.join('\n')).toMatch(/\[crm\] migrations to apply \(1\)/)
  })
  it('pending migrations in the control database only: migrate, tracker read for that database, then deploy', async () => {
    const { w, code } = await run(
      'redeploy',
      sim({ control: ['0001_c.sql'], live: { version: PKG_VERSION, commit: '1111111' } }),
    )
    expect(code).toBe(0)
    expect(steps(w)).toEqual([...READS, 'apply:CONTROL_DB', 'read:CONTROL_DB', 'deploy'])
  })
  it('pending in both: control first, then CRM, then deploy', async () => {
    const { w, code } = await run(
      'redeploy',
      sim({ control: null, crm: null, live: { version: PKG_VERSION, commit: '1111111' } }),
    )
    expect(code).toBe(0)
    expect(steps(w)).toEqual([...READS, 'apply:CONTROL_DB', 'read:CONTROL_DB', 'apply:DB', 'read:DB', 'deploy'])
  })
  it('--dry-run prints the plan, runs only the gate reads, needs no CONFIRM_REMOTE; exit 0', async () => {
    const { w, code } = await run('redeploy', sim(), ['--dry-run'], { processEnv: {} })
    expect(code).toBe(0)
    expect(writes(w)).toEqual([])
    expect(w.out.join('\n')).toMatch(/plan: redeploy/)
    expect(w.out.join('\n')).toMatch(/dry run/i)
    expect(URL_PATHS(w)).toEqual(['/health'])
    noTemp(w)
  })
  it('without CONFIRM_REMOTE it refuses after the plan with zero writes; exit 2 naming redeploy', async () => {
    const { w, code } = await run('redeploy', sim(), [], { processEnv: {} })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/vibase-server redeploy: .*CONFIRM_REMOTE=1/)
    expect(w.out.join('\n')).toMatch(/plan: redeploy/)
    expect(writes(w)).toEqual([])
  })
  it('a tampered package refuses before any call; exit 2', async () => {
    const w = worldFor(sim())
    writeFileSync(join(w.pkg.dir, 'worker', 'worker.js'), '// tampered')
    expect(await runRedeploy(['--env', 'demo'], w.deps)).toBe(2)
    expect(w.err.join('\n')).toMatch(/worker\/worker\.js/)
    expect(w.fetchUrls).toEqual([])
    expect(w.wrangler).toEqual([])
  })
  it('missing settings refuse before any call; exit 2', async () => {
    const w = worldFor(sim(), { settings: null })
    expect(await runRedeploy(['--env', 'demo'], w.deps)).toBe(2)
    expect(w.err.join('\n')).toMatch(/vibase-server redeploy:/)
    expect(w.fetchUrls).toEqual([])
    expect(w.wrangler).toEqual([])
  })
  it('an unreachable /health refuses; exit 2, no write', async () => {
    const w = worldFor(sim({ unreachable: true }))
    expect(await runRedeploy(['--env', 'demo'], w.deps)).toBe(2)
    expect(w.err.join('\n')).toMatch(/cannot reach/)
    expect(writes(w)).toEqual([])
  })
  it('arguments: --env required, unknown flags refuse (including --rollback), exit 2 before any call', async () => {
    for (const argv of [[], ['--env', 'demo', '--bogus'], ['--env', 'demo', '--rollback'], ['--env', 'Bad_Name']]) {
      const w = worldFor(sim())
      expect(await runRedeploy(argv, w.deps)).toBe(2)
      expect(w.err.join('\n')).toMatch(/vibase-server redeploy:/)
      expect(w.fetchUrls).toEqual([])
      expect(w.wrangler).toEqual([])
    }
  })
})

describe('OPS487 P2 failure stops, both modes (the matrix)', () => {
  const failed = (mode: Mode, w: World, code: number, stepRe: RegExp) => {
    expect(code).toBe(3)
    expect(w.err.join('\n')).toMatch(new RegExp(`^vibase-server ${mode}: .*partly`, 's'))
    expect(w.err.join('\n')).toMatch(stepRe)
    noTemp(w)
  }
  // The live instance is behind in both databases so both modes migrate: the same fake serves both.
  const behind = (over: Partial<Sim> = {}) => sim({ control: ['0001_c.sql'], crm: ['0001_a.sql'], ...over })
  for (const mode of ['upgrade', 'redeploy'] as const) {
    describe(mode, () => {
      it('control apply fails: no CRM apply, no deploy', async () => {
        const { w, code } = await run(mode, behind({ failControlApply: true }))
        failed(mode, w, code, /migrate control/)
        expect(writes(w)).toEqual(['apply:CONTROL_DB'])
      })
      it('the control tracker is still behind after its apply: no later write', async () => {
        const { w, code } = await run(mode, behind({ controlApplyNoop: true }))
        failed(mode, w, code, /tracker check control/)
        expect(writes(w)).toEqual(['apply:CONTROL_DB'])
      })
      it('CRM apply fails: no deploy', async () => {
        const { w, code } = await run(mode, behind({ failCrmApply: true }))
        failed(mode, w, code, /migrate crm/)
        expect(writes(w)).toEqual(['apply:CONTROL_DB', 'apply:DB'])
      })
      it('the post-migrate tracker is missing a package migration: no deploy', async () => {
        const { w, code } = await run(mode, behind({ crmApplyNoop: true }))
        failed(mode, w, code, /tracker check crm/)
        expect(writes(w)).not.toContain('deploy')
      })
      it('the post-migrate tracker is unknown (no tracker table): no deploy', async () => {
        const { w, code } = await run(mode, behind({ crmTrackerAfterApply: NO_TRACKER_JSON }))
        failed(mode, w, code, /tracker/)
        expect(writes(w)).not.toContain('deploy')
      })
      it('the post-migrate tracker is unreadable: no deploy', async () => {
        const { w, code } = await run(mode, behind({ crmTrackerAfterApply: 'not json at all' }))
        failed(mode, w, code, /tracker/)
        expect(writes(w)).not.toContain('deploy')
      })
      it('deploy fails: nothing is verified or smoked', async () => {
        const { w, code } = await run(mode, behind({ failDeploy: true }))
        failed(mode, w, code, /deploy/)
        expect(URL_PATHS(w)).toEqual(['/health'])
      })
      it('verify never sees the build: bounded at 300 s, then fails; no smoke', async () => {
        const { w, code } = await run(mode, sim({ neverSwitch: true }))
        failed(mode, w, code, /verify/)
        expect(w.clock.t).toBeGreaterThanOrEqual(300_000)
        expect(w.clock.t).toBeLessThan(320_000)
        expect(URL_PATHS(w)).not.toContain('/openapi.json')
      })
      it('a smoke check fails: exit 3 naming the check', async () => {
        const { w, code } = await run(mode, sim({ smoke: { '/openapi.json': [200, {}] } }))
        failed(mode, w, code, /smoke.*openapi\.json/s)
      })
    })
  }
  it('the redeploy failure line suggests running redeploy again, the upgrade one upgrade', async () => {
    const a = await run('redeploy', sim({ failDeploy: true }))
    expect(a.w.err.join('\n')).toMatch(/run `vibase-server status`.*run redeploy again/s)
    const b = await run('upgrade', sim({ failDeploy: true }))
    expect(b.w.err.join('\n')).toMatch(/run upgrade again/)
  })
})

describe('OPS487 secrets and side effects, both modes', () => {
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
  const echoing =
    (failOn: string): WorldOptions['runner'] =>
    (args, env) => {
      if (args.slice(0, 3).join(' ').startsWith(failOn))
        return {
          status: 1,
          stdout: JSON.stringify(env),
          stderr: `failed with env ${JSON.stringify(env)} token=${env.CLOUDFLARE_API_TOKEN}`,
        }
      if (args[0] === 'd1' && args[1] === 'execute')
        return {
          status: 0,
          stdout: trackerJson(bindingOf(args) === 'CONTROL_DB' ? ['0001_c.sql'] : ['0001_a.sql']),
          stderr: '',
        }
      return { status: 0, stdout: 'ok', stderr: '' }
    }
  for (const mode of ['upgrade', 'redeploy'] as const) {
    it(`${mode}: a failing migrate or deploy that echoes its whole env prints no secret`, async () => {
      for (const on of ['d1 migrations apply', 'deploy']) {
        const { w, code } = await run(mode, sim(), [], { runner: echoing(on) })
        expect(code).toBe(3)
        leaks(w)
        noTemp(w)
      }
    })
    it(`${mode}: the wrangler child gets the allow-listed environment only, on every call`, async () => {
      const { w } = await run(mode, sim(), [], {
        processEnv: { CONFIRM_REMOTE: '1', CLERK_SECRET_KEY: 'sk_live_nope' },
      })
      for (const c of w.wrangler)
        expect(Object.keys(c.env).sort()).toEqual([
          'CI',
          'CLOUDFLARE_ACCOUNT_ID',
          'CLOUDFLARE_API_TOKEN',
          'HOME',
          'PATH',
          'WRANGLER_SEND_METRICS',
        ])
      leaks(w)
    })
    it(`${mode}: no secret in any output or generated config, the runner never sees secret/versions/clerk/bootstrap, every request is a GET with no key`, async () => {
      const cases: Partial<Sim>[] = [{}, { failDeploy: true }, { control: ['0001_c.sql'], crm: ['0001_a.sql'] }]
      for (const c of cases) {
        const { w } = await run(mode, sim(c))
        leaks(w)
        for (const call of w.wrangler) {
          expect(call.args).not.toContain('secret')
          expect(call.args).not.toContain('versions')
          expect(call.args.join(' ')).not.toMatch(/clerk|bootstrap/i)
          expect(['d1', 'deploy']).toContain(call.args[0])
        }
        for (const f of w.fetchCalls) {
          expect((f.init?.method ?? 'GET').toUpperCase()).toBe('GET')
          expect(f.init?.body).toBeUndefined()
          const auth = (f.init?.headers as Record<string, string> | undefined)?.authorization
          if (auth !== undefined) expect(['Bearer vk_malformed', 'Bearer a.b.c']).toContain(auth)
        }
      }
    })
  }
})

describe('OPS487 D2/D3 rollback and the note', () => {
  const OLDER = { version: '0.2.0', commit: '2222222' }
  const cases: [string, Partial<Sim>, string[]][] = [
    ['CRM only', { crm: [...ALL, '0003_c.sql'] }, ['read:CONTROL_DB', 'read:DB', 'deploy']],
    ['control only', { control: [...CONTROL_ALL, '0003_x.sql'] }, ['read:CONTROL_DB', 'read:DB', 'deploy']],
    [
      'both',
      { control: [...CONTROL_ALL, '0003_x.sql'], crm: [...ALL, '0003_c.sql'] },
      ['read:CONTROL_DB', 'read:DB', 'deploy'],
    ],
    [
      'diverged in the CRM (a package migration missing and an unknown one present)',
      { crm: ['0001_a.sql', '0003_c.sql'] },
      ['read:CONTROL_DB', 'read:DB', 'apply:DB', 'read:DB', 'deploy'],
    ],
    [
      'diverged in the control database',
      { control: ['0001_c.sql', '0003_x.sql'] },
      ['read:CONTROL_DB', 'read:DB', 'apply:CONTROL_DB', 'read:CONTROL_DB', 'deploy'],
    ],
  ]
  for (const [name, over, expectedSteps] of cases) {
    it(`${name}: never refused, no migration unless something is pending, the note exactly once, verify accepts ahead`, async () => {
      const { w, code } = await run('redeploy', sim({ live: OLDER, ...over }))
      expect(w.err).toEqual([])
      expect(code).toBe(0)
      expect(steps(w)).toEqual(expectedSteps)
      expect(noteCount(w)).toBe(1)
      expect(w.out.join('\n')).toMatch(/redeployed demo/)
      noTemp(w)
    })
  }
  it('the note is printed with --dry-run too, once, and nothing is written', async () => {
    const { w, code } = await run('redeploy', sim({ live: OLDER, crm: [...ALL, '0003_c.sql'] }), ['--dry-run'])
    expect(code).toBe(0)
    expect(noteCount(w)).toBe(1)
    expect(writes(w)).toEqual([])
  })
  it('with no unknown migrations the note is absent, even when the live version is newer', async () => {
    const { w, code } = await run('redeploy', sim({ live: OLDER }))
    expect(code).toBe(0)
    expect(noteCount(w)).toBe(0)
    expect(w.all()).not.toMatch(/rolling back code/)
  })
  it('an older live version over a newer-schema database still prints the note (no version comparison drives it)', async () => {
    const { w } = await run(
      'redeploy',
      sim({ live: { version: '0.0.9', commit: '1111111' }, crm: [...ALL, '0003_c.sql'] }),
    )
    expect(noteCount(w)).toBe(1)
  })
  it('upgrade never prints the note and still refuses unknown migrations (D14 d)', async () => {
    const { w, code } = await run('upgrade', sim({ crm: [...ALL, '0003_c.sql'] }))
    expect(code).toBe(2)
    expect(noteCount(w)).toBe(0)
    expect(w.err.join('\n')).toMatch(/migrations this release does not know/)
    expect(writes(w)).toEqual([])
  })
  it('redeploy skips (d) for the control database as well: no refusal', async () => {
    const { code } = await run('redeploy', sim({ control: [...CONTROL_ALL, '0009_zzz.sql'] }))
    expect(code).toBe(0)
  })
})

describe('OPS487 D4/D6 upgrade tells builds apart', () => {
  const same = (commit: string | null): Partial<Sim> => ({ live: { version: PKG_VERSION, commit } })
  const stopped = (w: World, code: number, sha: string) => {
    expect(code).toBe(2)
    expect(w.all()).toContain(`same version, different build: live ${sha}, package ${PKG_COMMIT}`)
    expect(w.all()).toContain('vibase-server redeploy --env demo')
    expect(writes(w)).toEqual([])
    expect(w.out.join('\n')).not.toMatch(/nothing to do/)
  }
  it('same version, a different commit: the line and the redeploy pointer, zero writes, exit 2', async () => {
    const { w, code } = await run('upgrade', sim(same('1111111')))
    stopped(w, code, '1111111')
    expect(w.err.join('\n')).toMatch(/^vibase-server upgrade: same version, different build/)
  })
  it('the same stop with --dry-run, and without CONFIRM_REMOTE (it comes before the guard)', async () => {
    const a = await run('upgrade', sim(same('1111111')), ['--dry-run'])
    stopped(a.w, a.code, '1111111')
    const b = await run('upgrade', sim(same('1111111')), [], { processEnv: {} })
    stopped(b.w, b.code, '1111111')
    expect(b.w.err.join('\n')).not.toMatch(/CONFIRM_REMOTE/)
  })
  it('the same stop with migrations pending', async () => {
    const { w, code } = await run('upgrade', sim({ ...same('1111111'), crm: ['0001_a.sql'], control: ['0001_c.sql'] }))
    stopped(w, code, '1111111')
  })
  it('a live /health with no commit: `live unknown`, the same stop', async () => {
    const { w, code } = await run('upgrade', sim(same(null)))
    stopped(w, code, 'unknown')
  })
  it('a short and a full sha of the same commit are the same build: nothing to do, exit 0, no write', async () => {
    for (const commit of [FULL_SHA, PKG_COMMIT]) {
      const { w, code } = await run('upgrade', sim(same(commit)))
      expect(code).toBe(0)
      expect(w.out.join('\n')).toMatch(/nothing to do/)
      expect(writes(w)).toEqual([])
    }
  })
  it('a prefix shorter than 7 characters is not the same build', async () => {
    const { w, code } = await run('upgrade', sim(same(PKG_COMMIT.slice(0, 5))))
    stopped(w, code, PKG_COMMIT.slice(0, 5))
  })
  it('a dirty build and a clean one of the same sha are different builds (decision 487.18)', async () => {
    const { w, code } = await run('upgrade', sim(same(`${PKG_COMMIT}-dirty`)))
    stopped(w, code, `${PKG_COMMIT}-dirty`)
  })
  it('the same build with a pending migration keeps migrating and deploying (the repair path)', async () => {
    const { w, code } = await run('upgrade', sim({ ...same(PKG_COMMIT), crm: ['0001_a.sql'] }))
    expect(code).toBe(0)
    expect(writes(w)).toEqual(['apply:CONTROL_DB', 'apply:DB', 'deploy'])
  })
  it('a newer live semver still refuses, now naming redeploy', async () => {
    const { w, code } = await run('upgrade', sim({ live: { version: '0.2.0', commit: '2222222' } }))
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/vibase-server redeploy/)
    expect(w.err.join('\n')).not.toMatch(/--rollback/)
    expect(writes(w)).toEqual([])
  })
  it('upgrade --rollback and status --rollback refuse (exit 2) naming redeploy, before any call', async () => {
    for (const [name, fn] of [
      ['upgrade', runUpgrade],
      ['status', runStatus],
    ] as const) {
      const w = worldFor(sim())
      expect(await fn(['--env', 'demo', '--rollback'], w.deps)).toBe(2)
      expect(w.err.join('\n')).toMatch(
        new RegExp(`^vibase-server ${name}: .*--rollback was replaced by vibase-server redeploy`),
      )
      expect(w.fetchUrls).toEqual([])
      expect(w.wrangler).toEqual([])
    }
  })
})

describe('OPS487 D5 verify waits for the build', () => {
  // `upgrade` only proceeds from an older version, so its old Worker already shows the package's version only through a lagging `/health`: the lag models the
  // old Worker still answering (same old commit) for N polls; `redeploy` runs on the same-version, different-commit instance the bug is about.
  const starts: Record<Mode, Live> = {
    upgrade: { version: '0.0.9', commit: '1111111' },
    redeploy: { version: PKG_VERSION, commit: '1111111' },
  }
  for (const mode of ['upgrade', 'redeploy'] as const) {
    it(`${mode}: the old build answered for N polls, then the new one: keeps polling and succeeds only after the switch`, async () => {
      const { w, code } = await run(mode, sim({ live: starts[mode], lag: 3 }))
      expect(code).toBe(0)
      expect(w.clock.t).toBeGreaterThanOrEqual(30_000)
      expect(w.clock.t).toBeLessThan(300_000)
      expect(w.out.filter((l) => l.includes('waiting for the instance to come up'))).toHaveLength(3)
    })
    it(`${mode}: a /health that never switches fails verify (exit 3), no smoke`, async () => {
      const { w, code } = await run(mode, sim({ live: starts[mode], neverSwitch: true }))
      expect(code).toBe(3)
      expect(w.err.join('\n')).toMatch(/verify/)
      expect(URL_PATHS(w)).not.toContain('/openapi.json')
    })
  }
  it('a same-version Worker that shows the package version with the old commit is not the new build', async () => {
    // The package's version alone would pass at once; only the commit tells the Worker has not switched.
    const { w, code } = await run('redeploy', sim({ live: starts.redeploy, neverSwitch: true }))
    expect(code).toBe(3)
    expect(w.err.join('\n')).toMatch(/commit 1111111|1111111/)
  })
  it('redeploy on the same version: the old Worker answering the package version with the old commit is not verified', async () => {
    const { w, code } = await run('redeploy', sim({ live: { version: PKG_VERSION, commit: '1111111' }, lag: 2 }))
    expect(code).toBe(0)
    expect(w.clock.t).toBeGreaterThanOrEqual(20_000)
  })
  it('a /health with no commit verifies on version alone (the old build had none)', async () => {
    const { w, code } = await run('redeploy', sim({ live: { version: '0.0.9', commit: null }, noCommitAfter: true }))
    expect(code).toBe(0)
    expect(w.clock.t).toBe(0)
  })
})

describe('OPS487 D7 status tells builds apart', () => {
  const status = async (s: Sim, argv = ['--env', 'demo']) => {
    const w = worldFor(s)
    return { w, code: await runStatus(argv, w.deps) }
  }
  it('same version, different build: the line and the pointer, exit 1, no nothing-to-do claim, no write', async () => {
    const { w, code } = await status(sim({ live: { version: PKG_VERSION, commit: '1111111' } }))
    expect(code).toBe(1)
    const out = w.out.join('\n')
    expect(out).toContain(`same version, different build: live 1111111, package ${PKG_COMMIT}`)
    expect(out).toContain('vibase-server redeploy --env demo')
    expect(out).not.toMatch(/nothing to do/)
    expect(writes(w)).toEqual([])
  })
  it('a live /health with no commit: `live unknown`, exit 1', async () => {
    const { w, code } = await status(sim({ live: { version: PKG_VERSION, commit: null } }))
    expect(code).toBe(1)
    expect(w.out.join('\n')).toContain(`same version, different build: live unknown, package ${PKG_COMMIT}`)
  })
  it('same build and current: nothing to do, exit 0', async () => {
    const { w, code } = await status(sim({ live: { version: PKG_VERSION, commit: PKG_COMMIT } }))
    expect(code).toBe(0)
    expect(w.out.join('\n')).toMatch(/nothing to do/)
  })
})
