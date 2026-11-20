// OPS308 on `vibase-server setup`: `--workers-dev` (D12), the record and its generated config, `status` and `upgrade` on a workers.dev settings file, the one base URL and one
// verify bound (P1, P2), `--change-host` (D14, P5). The same obligations for `setup:remote` are in setup/workers-dev.test.ts. Everything runs against the instance kit's fake wrangler
// and fetch (its subdomain answers are the shared builder of setup/test/subdomain-answers.ts, which cites Cloudflare's reference), a real settings and secrets file, and two real local D1s.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { discoveryAnswer } from '../setup/test/better-auth-answers.js'
import { ALL_MIGRATIONS, API_HOST, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { runStatus } from './status.js'
import { runUpgrade } from './upgrade.js'
import {
  CONTROL_ALL,
  CONTROL_UUID,
  SECRETS_TEXT,
  UUID,
  captureHealthBody,
  cleanup,
  controlSettings,
  makeWorld,
  validSettings,
} from './test-kit.js'

const OWNER = 'owner@example.com'
const BASE = `https://${API_HOST}`
const WD_HOST = 'vb-demo.team.workers.dev'
const WD_BASE = `https://${WD_HOST}`
const NEW = ['--env', 'demo', '--owner-email', OWNER]
const WD = [...NEW, '--workers-dev']
const CHANGE = [...NEW, '--api-host', API_HOST, '--change-host']
const BA = (base: string) => ({ AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: base, CORS_ALLOWED_ORIGINS: '' })
const RECORD_WD = controlSettings({ worker: 'vb-demo', api_host: WD_HOST, workers_dev: true, vars: BA(WD_BASE) })
const RECORD_CUSTOM = controlSettings({ vars: BA(BASE) })
const RECORD_CLERK = controlSettings({ vars: { AUTH_PROVIDER: 'clerk' } })
const GOOGLE = 'AUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=gsecret-0123456789\n'
const gmail = (base?: string) =>
  `${SECRETS_TEXT}GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=gsecret-0123456789\nOAUTH_STATE_SECRET=state-0123456789\nCREDENTIALS_KEY=${Buffer.alloc(32, 7).toString('base64')}\n${base ? `PUBLIC_BASE_URL=${base}\n` : ''}`
const CONSEQUENCES = ['sign in again', 'vibase login', 'reconnect MCP']

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
beforeEach(async () => {
  await pair.reset()
})
afterEach(() => cleanup())

const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld => setupWorld({ d1: pair, control: pair.control, ...o })
const run = (s: SetupWorld, argv: string[]) => runSetup(argv, s.w.deps)
const row = (s: SetupWorld, name: string) => s.rows().find((r) => r.step === name)!
const hostOf = (s: SetupWorld) =>
  /api host (\S+?)(?: \(workers\.dev\))?,/.exec(s.w.out.find((l) => l.startsWith('setup: env')) ?? '')?.[1]
const settings = (s: SetupWorld) => JSON.parse(s.settings()!) as Record<string, any>
const configs = (s: SetupWorld) =>
  s.w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
const pkgManifest = (s: SetupWorld) =>
  JSON.parse(readFileSync(join(s.w.pkg.dir, 'release.json'), 'utf8')) as { version: string; commit: string }
/** An instance that is recorded, created, migrated and deployed at the package's version. */
function recordedWorld(settingsOver: Record<string, unknown>, o: Partial<SetupWorldOptions> = {}): SetupWorld {
  const s = world({
    settings: settingsOver,
    secretsText: SECRETS_TEXT,
    ...o,
    sim: {
      d1s: [
        { uuid: UUID, name: 'vault-demo' },
        { uuid: CONTROL_UUID, name: 'ctl-recorded-name' },
      ],
      r2s: ['vault-demo-bodies'],
      applied: [...ALL_MIGRATIONS],
      controlApplied: [...CONTROL_ALL],
      ...o.sim,
    },
  })
  const m = pkgManifest(s)
  s.sim.deployed = { version: m.version, commit: m.commit }
  return s
}
const sleptTotal = (s: SetupWorld) => s.w.clock.t

async function expectRefused(s: SetupWorld, argv: string[], needles: string[], o: { calls?: boolean } = {}) {
  const before = s.settings()
  expect(await run(s, [...argv, '--dry-run']), s.w.all()).toBe(2)
  expect(s.w.wrangler).toEqual([])
  expect(s.settings()).toBe(before)
  expect(s.sim.subdomain.puts).toEqual([])
  if (o.calls !== true) expect(s.w.fetchUrls).toEqual([])
  for (const n of needles) expect(s.w.err.join('\n'), n).toContain(n)
}

describe('1. host flag rules (D12, P4, P6): the matrix', () => {
  it.each([
    ['neither --api-host nor --workers-dev', NEW, ['--api-host', '--workers-dev']],
    ['both flags', [...NEW, '--api-host', API_HOST, '--workers-dev'], ['exactly one']],
    [
      'an --api-host under workers.dev',
      [...NEW, '--api-host', 'vb-demo.team.workers.dev'],
      ['--workers-dev', 'workers.dev'],
    ],
    ['--workers-dev with --auth clerk', [...NEW, '--workers-dev', '--auth', 'clerk'], ['clerk']],
    [
      '--register-workers-subdomain without --workers-dev',
      [...NEW, '--api-host', API_HOST, '--register-workers-subdomain', 'team'],
      ['--register-workers-subdomain', '--workers-dev'],
    ],
    ['--change-host on a new instance', [...NEW, '--api-host', API_HOST, '--change-host'], ['--change-host']],
  ] as [string, string[], string[]][])(
    'a new instance with %s is refused (exit 2) before any call',
    async (_n, argv, needles) => {
      await expectRefused(world(), argv, needles)
    },
  )

  it('a recorded workers.dev instance given another --api-host without --change-host: refused, naming the flag and the consequences', async () => {
    await expectRefused(
      recordedWorld(RECORD_WD),
      [...NEW, '--api-host', API_HOST],
      ['--change-host', 'sign in again', 'vibase login'],
    )
  })
  it.each([
    ['without --change-host', []],
    ['with --change-host (P4: custom domain to workers.dev is not offered)', ['--change-host']],
  ])('a recorded custom-domain instance given --workers-dev %s: refused', async (_n, extra) => {
    await expectRefused(recordedWorld(RECORD_CUSTOM), [...NEW, '--workers-dev', ...extra], ['custom domain'])
  })
  it('--change-host on a Clerk record (P6): refused, naming Clerk', async () => {
    await expectRefused(
      recordedWorld(RECORD_CLERK),
      [...NEW, '--api-host', 'api2.demo.invalid', '--change-host'],
      ['--change-host', 'Clerk'],
    )
  })
  it.each([
    ['better-auth', WD],
    ['none', ['--env', 'demo', '--auth', 'none', '--workers-dev']],
  ])('--workers-dev with %s is accepted and derives <worker>.<subdomain>.workers.dev', async (_n, argv) => {
    const s = world()
    expect(await run(s, [...argv, '--dry-run']), s.w.all()).toBe(0)
    expect(hostOf(s)).toBe(WD_HOST)
  })
})

describe('2. the subdomain read, registration and preflight (D12, P3)', () => {
  it('a registered subdomain: the host is derived from it and the worker name, and nothing is registered', async () => {
    const s = world()
    expect(await run(s, [...WD, '--dry-run']), s.w.all()).toBe(0)
    expect(hostOf(s)).toBe(WD_HOST)
    expect(s.w.fetchUrls.some((u) => u.endsWith('/workers/subdomain'))).toBe(true)
    expect(s.sim.subdomain.puts).toEqual([])
  })
  it('none and no flag: refused, naming the dashboard path and the flag; no PUT, no write', async () => {
    const s = world({ sim: { subdomain: { subdomain: null, puts: [] } } })
    expect(await run(s, WD)).toBe(2)
    expect(s.w.err.join('\n')).toContain('Workers & Pages')
    expect(s.w.err.join('\n')).toContain('--register-workers-subdomain')
    expect(s.sim.subdomain.puts).toEqual([])
    expect(s.settings()).toBeNull()
    expect(s.writes()).toEqual([])
  })
  it('none with the flag: exactly one PUT with that name, then setup proceeds on the derived host', async () => {
    const s = world({ sim: { subdomain: { subdomain: null, puts: [] } } })
    expect(await run(s, [...WD, '--register-workers-subdomain', 'newsub']), s.w.all()).toBe(0)
    expect(s.sim.subdomain.puts).toEqual(['newsub'])
    expect(hostOf(s)).toBe('vb-demo.newsub.workers.dev')
    expect(settings(s).api_host).toBe('vb-demo.newsub.workers.dev')
  })
  it.each([
    ['a partial Gmail group in the secrets file', `${SECRETS_TEXT}GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\n`],
    ['a Gmail PUBLIC_BASE_URL naming another host', gmail('https://other.example.com')],
  ])(
    'the registration is the first write: %s is refused (exit 2) and nothing is registered',
    async (_n, secretsText) => {
      const s = world({ secretsText, sim: { subdomain: { subdomain: null, puts: [] } } })
      expect(await run(s, [...WD, '--register-workers-subdomain', 'newsub'])).toBe(2)
      expect(s.sim.subdomain.puts).toEqual([])
      expect(s.writes()).toEqual([])
    },
  )
  it('OPS493 D4: on a terminal `n` before the registration: no PUT, no write, exit 0; `y` registers once', async () => {
    const n = world({ terminal: true, answers: ['n'], sim: { subdomain: { subdomain: null, puts: [] } } })
    expect(await run(n, [...WD, '--register-workers-subdomain', 'newsub']), n.w.all()).toBe(0)
    expect(n.w.asked).toHaveLength(1)
    expect(n.sim.subdomain.puts).toEqual([])
    expect(n.writes()).toEqual([])
    const y = world({ terminal: true, answers: ['y'], sim: { subdomain: { subdomain: null, puts: [] } } })
    expect(await run(y, [...WD, '--register-workers-subdomain', 'newsub']), y.w.all()).toBe(0)
    expect(y.sim.subdomain.puts).toEqual(['newsub'])
  })
  it('a preflight that fails registers nothing', async () => {
    const s = world({ sim: { subdomain: { subdomain: null, puts: [] }, denyAll: true } })
    expect(await run(s, [...WD, '--register-workers-subdomain', 'newsub'])).not.toBe(0)
    expect(s.sim.subdomain.puts).toEqual([])
  })
  it('a dry run with the flag: no PUT, reported as planned, the host still derived', async () => {
    const s = world({ sim: { subdomain: { subdomain: null, puts: [] } } })
    expect(await run(s, [...WD, '--register-workers-subdomain', 'newsub', '--dry-run']), s.w.all()).toBe(0)
    expect(s.sim.subdomain.puts).toEqual([])
    expect(s.w.all()).toMatch(/would register.*newsub/)
    expect(hostOf(s)).toBe('vb-demo.newsub.workers.dev')
  })
  it('the flag while the account has a different subdomain: refused naming it, no PUT (setup never renames)', async () => {
    const s = world()
    expect(await run(s, [...WD, '--register-workers-subdomain', 'other'])).toBe(2)
    expect(s.w.err.join('\n')).toContain('team')
    expect(s.sim.subdomain.puts).toEqual([])
    expect(s.settings()).toBeNull()
  })
  it('the flag naming the subdomain the account already has is no rename: accepted, no PUT', async () => {
    const s = world()
    expect(await run(s, [...WD, '--register-workers-subdomain', 'team', '--dry-run']), s.w.all()).toBe(0)
    expect(s.sim.subdomain.puts).toEqual([])
  })
  it('a malformed name is refused before any call', async () => {
    await expectRefused(
      world({ sim: { subdomain: { subdomain: null, puts: [] } } }),
      [...WD, '--register-workers-subdomain', 'Bad_Name'],
      ['--register-workers-subdomain'],
    )
  })
  it('a token that cannot read the subdomain: refused naming the permission', async () => {
    const s = world({ sim: { subdomain: { subdomain: 'team', puts: [], denied: true } } })
    expect(await run(s, WD)).toBe(2)
    expect(s.w.err.join('\n')).toContain('Workers Scripts')
    expect(s.settings()).toBeNull()
  })
  it('a renamed account subdomain on a recorded workers.dev instance is a host change: refused without --change-host, nothing written', async () => {
    const s = recordedWorld({
      ...RECORD_WD,
      api_host: 'vb-demo.old.workers.dev',
      vars: BA('https://vb-demo.old.workers.dev'),
    })
    const before = s.settings()
    expect(await run(s, WD)).toBe(2)
    expect(s.w.err.join('\n')).toContain('--change-host')
    expect(s.settings()).toBe(before)
    expect(s.writes()).toEqual([])
  })
  it('preflight in workers.dev mode makes no zone call and still checks D1, R2 and Workers; a custom domain still checks the zone', async () => {
    const s = world()
    await run(s, [...WD, '--dry-run'])
    expect(row(s, 'preflight').status).toBe('ok')
    expect(s.w.fetchUrls.filter((u) => /\/zones\?/.test(u))).toEqual([])
    for (const p of ['/d1/database', '/r2/buckets', '/workers/scripts'])
      expect(
        s.w.fetchUrls.some((u) => u.includes(p)),
        p,
      ).toBe(true)
    const c = world()
    await run(c, [...NEW, '--api-host', API_HOST, '--dry-run'])
    expect(c.w.fetchUrls.some((u) => /\/zones\?/.test(u))).toBe(true)
  })
})

describe('3. the record, the generated config, status and upgrade (D12)', () => {
  it('a workers.dev run writes workers_dev true and the derived host, and every generated config has workers_dev true and no routes', async () => {
    const s = world()
    expect(await run(s, WD), s.w.all()).toBe(0)
    expect(settings(s)).toMatchObject({ workers_dev: true, api_host: WD_HOST, worker: 'vb-demo', vars: BA(WD_BASE) })
    const cs = configs(s)
    expect(cs.length).toBeGreaterThan(0)
    for (const c of cs) {
      expect(c.workers_dev).toBe(true)
      expect(c.routes).toBeUndefined()
    }
  })
  it('none: workers_dev true and no PUBLIC_BASE_URL', async () => {
    const s = world()
    expect(await run(s, ['--env', 'demo', '--auth', 'none', '--workers-dev']), s.w.all()).toBe(0)
    expect(settings(s).workers_dev).toBe(true)
    expect(settings(s).vars.PUBLIC_BASE_URL).toBeUndefined()
  })
  it('a custom-domain run leaves the key out and generates workers_dev false with the custom_domain route (the empty state)', async () => {
    const s = world()
    expect(await run(s, [...NEW, '--api-host', API_HOST]), s.w.all()).toBe(0)
    expect('workers_dev' in settings(s)).toBe(false)
    for (const c of configs(s)) {
      expect(c.workers_dev).toBe(false)
      expect(c.routes).toEqual([{ pattern: API_HOST, custom_domain: true }])
    }
  })
  it('status on a workers.dev settings file reads the derived host', async () => {
    const HEALTH = await captureHealthBody()
    const w = makeWorld({
      settings: validSettings({ worker: 'vb-demo', api_host: WD_HOST, workers_dev: true }),
      health: () => new Response(JSON.stringify({ ...HEALTH, version: '0.1.0' }), { status: 200 }),
    })
    await runStatus(['--env', 'demo'], w.deps)
    expect(w.out.join('\n')).toContain(`at ${WD_BASE}`)
    expect(w.fetchUrls.every((u) => u.startsWith(`${WD_BASE}/`))).toBe(true)
  })
  it('upgrade on a workers.dev settings file: its generated config has no route, and it reads the derived host', async () => {
    const HEALTH = await captureHealthBody()
    const w = makeWorld({
      settings: validSettings({ worker: 'vb-demo', api_host: WD_HOST, workers_dev: true }),
      health: () => new Response(JSON.stringify({ ...HEALTH, version: '0.0.1' }), { status: 200 }),
    })
    await runUpgrade(['--env', 'demo', '--dry-run'], w.deps)
    expect(w.out.join('\n')).toContain(WD_BASE)
    expect(w.fetchUrls.length).toBeGreaterThan(0)
    expect(w.fetchUrls.every((u) => u.startsWith(`${WD_BASE}/`))).toBe(true)
    const cfg = w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
    expect(cfg.length).toBeGreaterThan(0)
    for (const c of cfg) {
      expect(c.workers_dev).toBe(true)
      expect(c.routes).toBeUndefined()
    }
  })
})

describe('4. one base URL and one verify bound (P1, P2)', () => {
  it('a full workers.dev run reads health, discovery and metadata on the derived host and uses the same base everywhere', async () => {
    const s = world({ secretsText: `${SECRETS_TEXT}${GOOGLE}`, sim: { ba: { signInMethods: ['password', 'google'] } } })
    expect(await run(s, WD), s.w.all()).toBe(0)
    const worker = s.w.fetchUrls.filter((u) => !u.startsWith('https://api.cloudflare.com/'))
    for (const u of worker) expect(u.startsWith(`${WD_BASE}/`), u).toBe(true)
    for (const p of ['/health', '/.well-known/vibase', '/.well-known/oauth-authorization-server/auth'])
      expect(worker, p).toContain(`${WD_BASE}${p}`)
    const invites = s.w.out.filter((l) => l.includes('/invite#token='))
    expect(invites.length).toBe(1)
    expect(invites[0]).toContain(`${WD_BASE}/invite#token=`)
    expect(s.w.out.join('\n')).toContain(`vibase login --server ${WD_BASE}`)
    expect(s.w.out.join('\n')).toContain(`${WD_BASE}/auth/callback/google`)
  })
  it('the expected issuer is the derived base, never what the Worker says: another issuer fails verify', async () => {
    const s = world({ sim: { ba: { vibase: [{ status: 200, body: discoveryAnswer('https://other.example.com') }] } } })
    expect(await run(s, WD)).toBe(3)
    expect(row(s, 'verify').detail).toContain(`${WD_BASE}/auth`)
  })
  it('a Gmail-group PUBLIC_BASE_URL equal to the derived base is accepted, one naming another host is refused', async () => {
    const ok = world({ secretsText: gmail(WD_BASE) })
    expect(await run(ok, WD), ok.w.all()).toBe(0)
    expect(settings(ok).vars.PUBLIC_BASE_URL).toBe(WD_BASE)
    const bad = world({ secretsText: gmail('https://other.example.com') })
    expect(await run(bad, WD)).toBe(2)
    expect(bad.w.err.join('\n')).toMatch(/PUBLIC_BASE_URL/)
    expect(bad.settings()).toBeNull()
  })
  it("health current after 200 s, then discovery answering 5xx: fails by 300 s from verify's start, and says so", async () => {
    const s: SetupWorld = recordedWorld(RECORD_WD, {
      sim: { ba: { vibase: [{ status: 500 }] } },
      interceptFetch: (url) =>
        url.endsWith('/health') && s.w.clock.t < 200_000
          ? new Response(JSON.stringify({ status: 'ok', version: 'x', migrations: { status: 'behind' } }), {
              status: 200,
            })
          : undefined,
    })
    expect(await run(s, [...WD, '--only', 'verify'])).toBe(3)
    expect(row(s, 'verify').status).toBe('fail')
    expect(row(s, 'verify').detail).toContain('300s')
    expect(sleptTotal(s)).toBe(300_000)
  })
  it('health at once and discovery 5xx for 290 s still passes', async () => {
    const answer = { status: 200, body: discoveryAnswer(WD_BASE) }
    const s = recordedWorld(RECORD_WD, {
      sim: { ba: { vibase: [...Array.from({ length: 29 }, () => ({ status: 500 })), answer] } },
    })
    expect(await run(s, [...WD, '--only', 'verify']), s.w.all()).toBe(0)
    expect(sleptTotal(s)).toBe(290_000)
  })
})

describe('5. --change-host (D14, P5)', () => {
  const ONLY = ['--only', 'preflight,config:write,deploy,verify']
  it('without the flag a differing --api-host is refused naming the consequences, nothing written', async () => {
    const s = recordedWorld(RECORD_WD)
    const before = s.settings()
    expect(await run(s, [...NEW, '--api-host', API_HOST])).toBe(2)
    for (const n of CONSEQUENCES) expect(s.w.err.join('\n'), n).toContain(n)
    expect(s.settings()).toBe(before)
    expect(s.writes()).toEqual([])
  })
  it('from workers.dev: zone check, workers_dev kept, the route added, host and PUBLIC_BASE_URL rewritten, a deploy even at the same version, verify on the new host, the consequences and the Google redirect URI; the re-run is plain', async () => {
    const s = recordedWorld(RECORD_WD, { sim: { ba: { signInMethods: ['password', 'google'] } } })
    expect(await run(s, [...CHANGE, ...ONLY]), s.w.all()).toBe(0)
    expect(s.w.fetchUrls.some((u) => /\/zones\?name=/.test(u))).toBe(true)
    expect(settings(s)).toMatchObject({ workers_dev: true, api_host: API_HOST, vars: BA(BASE) })
    const deploy = s.w.wrangler.find((c) => c.args[0] === 'deploy')
    expect(deploy, 'a deploy is forced: the instance is already at the package version').toBeDefined()
    const cfg = JSON.parse(deploy!.configText!) as Record<string, any>
    expect(cfg.workers_dev).toBe(true)
    expect(cfg.routes).toEqual([{ pattern: API_HOST, custom_domain: true }])
    expect(s.w.fetchUrls).toContain(`${BASE}/health`)
    const out = s.w.out.join('\n')
    for (const n of CONSEQUENCES) expect(out, n).toContain(n)
    expect(out).toContain(`${BASE}/auth/callback/google`)
    expect(out).not.toContain('/oauth/google/callback')
    // the re-run with --api-host alone is a plain re-run
    s.w.out.length = 0
    s.w.wrangler.length = 0
    expect(await run(s, [...NEW, '--api-host', API_HOST, '--only', 'config:write,verify']), s.w.all()).toBe(0)
    expect(row(s, 'config:write').status).toBe('ok')
    expect(s.w.out.join('\n')).not.toContain('sign in again')
    expect(s.w.wrangler.some((c) => c.args[0] === 'deploy')).toBe(false)
  })
  it('a Gmail-only instance is told the Gmail callback, not the Better Auth Google sign-in one', async () => {
    const s = recordedWorld(RECORD_WD, { secretsText: gmail() })
    expect(await run(s, [...CHANGE, ...ONLY]), s.w.all()).toBe(0)
    const out = s.w.out.join('\n')
    expect(out).toContain(`${BASE}/oauth/google/callback`)
    expect(out).not.toContain('/auth/callback/google')
  })
  it('a missing zone for the new host is refused before any write', async () => {
    const s = recordedWorld(RECORD_WD, { sim: { zones: [] } })
    const before = s.settings()
    expect(await run(s, [...CHANGE, ...ONLY])).toBe(3)
    expect(row(s, 'preflight').status).toBe('fail')
    expect(s.settings()).toBe(before)
    expect(s.writes()).toEqual([])
  })
  it('custom to custom: the old route is replaced, not kept, and a manual line names the old domain', async () => {
    const s = recordedWorld(RECORD_CUSTOM)
    expect(await run(s, [...NEW, '--api-host', 'api2.demo.invalid', '--change-host', ...ONLY]), s.w.all()).toBe(0)
    expect(settings(s).api_host).toBe('api2.demo.invalid')
    const cfg = JSON.parse(s.w.wrangler.find((c) => c.args[0] === 'deploy')!.configText!) as Record<string, any>
    expect(cfg.routes).toEqual([{ pattern: 'api2.demo.invalid', custom_domain: true }])
    expect(s.w.out.join('\n')).toMatch(
      new RegExp(`manual:[\\s\\S]*${API_HOST.replaceAll('.', '\\.')}[\\s\\S]*may still be attached`),
    )
  })
  it('a dry run writes nothing and reports the change', async () => {
    const s = recordedWorld(RECORD_WD)
    const before = s.settings()
    expect(await run(s, [...CHANGE, '--dry-run']), s.w.all()).toBe(0)
    expect(s.settings()).toBe(before)
    expect(s.writes()).toEqual([])
    expect(s.w.out.join('\n')).toContain(`host change: ${WD_HOST} -> ${API_HOST}`)
    for (const n of CONSEQUENCES) expect(s.w.out.join('\n'), n).toContain(n)
  })
})
