// OPS308 on `setup:remote`: `--workers-dev` (D12), the one base URL and one verify bound (P1, P2), `--change-host` (D14, P5). The same obligations for `vibase-server setup` are in
// instance/setup-workers-dev.test.ts. Everything runs against the setup kit's faked wrangler, Cloudflare API (the subdomain answers are the shared builder of test/subdomain-answers.ts,
// which cites Cloudflare's reference) and fetch, with two real local D1s behind the proxy. Nothing reaches a real account.
import { readFileSync } from 'node:fs'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { runSetup } from './run.js'
import { discoveryAnswer } from './test/better-auth-answers.js'
import { FIXTURE_CONFIG_PATH, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const OWNER = 'owner@example.com'
const HOST = 'api.acme.vibase.ai'
const BASE = `https://${HOST}`
const WD_HOST = 'vb-acme.team.workers.dev'
const WD_BASE = `https://${WD_HOST}`
const NEW = ['--env', 'acme', '--owner-email', OWNER]
const WD = [...NEW, '--workers-dev']
const CHANGE = [...NEW, '--api-host', HOST, '--change-host']
const fixture = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const BA = (base: string) => ({ AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: base, CORS_ALLOWED_ORIGINS: '' })
const withBlock = (block: Record<string, unknown>) =>
  applyEdits(
    fixture,
    modify(fixture, ['env', 'acme'], block, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  )
const RECORD_WD = withBlock({ name: 'vb-acme', workers_dev: true, vars: BA(WD_BASE) })
const RECORD_CUSTOM = withBlock({
  name: 'vb-acme',
  workers_dev: false,
  routes: [{ pattern: HOST, custom_domain: true }],
  vars: BA(BASE),
})
const RECORD_CLERK = withBlock({
  name: 'vb-acme',
  workers_dev: false,
  routes: [{ pattern: HOST, custom_domain: true }],
  vars: { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: 'https://clerk.acme.example' },
})
const GOOGLE = 'AUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=gsecret-0123456789\n'
const gmail = (base?: string) =>
  `GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=gsecret-0123456789\nOAUTH_STATE_SECRET=state-0123456789\nCREDENTIALS_KEY=${Buffer.alloc(32, 7).toString('base64')}\n${base ? `PUBLIC_BASE_URL=${base}\n` : ''}`

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

const world = (o: Partial<WorldOptions> = {}): World =>
  makeWorld({ d1: pair.d1, control: pair.control, clerkEnvText: null, ...o })
const run = (w: World, argv: string[]) => runSetup(argv, CONFIRM, w.deps)
const dry = (w: World, argv: string[]) => runSetup([...argv, '--dry-run'], {}, w.deps)
const said = (w: World) => w.logs.join('\n')
const hostOf = (w: World) => /api host (\S+)/.exec(w.logs.find((l) => l.startsWith('setup:remote env')) ?? '')?.[1]
const block = (w: World) => (parse(w.state.configText) as { env: Record<string, any> }).env.acme
const step = (o: Awaited<ReturnType<typeof runSetup>>, name: string) => o.results.find((r) => r.step === name)!
/** The first run of a new instance writes the env block and stops ([[OPS65]] D10); the second one does the rest. */
async function fullRun(w: World, argv: string[]) {
  const first = await run(w, argv)
  expect(first.stoppedAfterConfigWrite, said(w)).toBe(true)
  w.logs.length = 0
  return run(w, argv)
}
/** A refusal before any call: exit 1, no results, no wrangler call, no Cloudflare request, nothing written. */
async function expectRefused(w: World, argv: string[], needles: string[], o: { calls?: boolean } = {}) {
  const r = await dry(w, argv)
  expect(r.exitCode, said(w)).toBe(1)
  expect(r.results).toEqual([])
  expect(w.argv).toEqual([])
  expect(w.state.configWrites).toBe(0)
  expect(w.state.subdomain.puts).toEqual([])
  if (o.calls !== true) expect(w.fetched).toEqual([])
  for (const n of needles) expect(said(w), n).toContain(n)
}

describe('1. host flag rules (D12, P4, P6): the matrix', () => {
  it.each([
    ['neither --api-host nor --workers-dev', NEW, ['--api-host', '--workers-dev']],
    ['both flags', [...NEW, '--api-host', HOST, '--workers-dev'], ['exactly one']],
    [
      'an --api-host under workers.dev',
      [...NEW, '--api-host', 'vb-acme.team.workers.dev'],
      ['--workers-dev', 'workers.dev'],
    ],
    ['--workers-dev with --auth clerk', [...NEW, '--workers-dev', '--auth', 'clerk'], ['clerk']],
    [
      '--register-workers-subdomain without --workers-dev',
      [...NEW, '--api-host', HOST, '--register-workers-subdomain', 'team'],
      ['--register-workers-subdomain', '--workers-dev'],
    ],
    ['--change-host on a new instance', [...NEW, '--api-host', HOST, '--change-host'], ['--change-host']],
  ] as [string, string[], string[]][])(
    'a new instance with %s is refused before any call',
    async (_n, argv, needles) => {
      await expectRefused(world(), argv, needles)
    },
  )

  it('a recorded workers.dev instance given another --api-host without --change-host: refused, naming the flag and the consequences', async () => {
    await expectRefused(
      world({ configText: RECORD_WD }),
      [...NEW, '--api-host', HOST],
      ['--change-host', 'sign in again', 'vibase login'],
    )
  })
  it.each([
    ['without --change-host', []],
    ['with --change-host (P4: custom domain to workers.dev is not offered)', ['--change-host']],
  ])('a recorded custom-domain instance given --workers-dev %s: refused', async (_n, extra) => {
    await expectRefused(world({ configText: RECORD_CUSTOM }), [...NEW, '--workers-dev', ...extra], ['custom domain'])
  })
  it('--change-host on a Clerk record (P6): refused, naming Clerk', async () => {
    await expectRefused(
      world({ configText: RECORD_CLERK, clerkEnvText: undefined }),
      ['--env', 'acme', '--owner-email', OWNER, '--api-host', 'api2.acme.vibase.ai', '--change-host'],
      ['--change-host', 'Clerk'],
    )
  })
  it.each([
    ['better-auth', [...WD]],
    ['none', ['--env', 'acme', '--auth', 'none', '--workers-dev']],
  ])('--workers-dev with %s is accepted and derives <worker>.<subdomain>.workers.dev', async (_n, argv) => {
    const w = world()
    const r = await dry(w, argv)
    expect(r.exitCode, said(w)).toBe(0)
    expect(hostOf(w)).toBe(WD_HOST)
  })
})

describe('2. the subdomain read, registration and preflight (D12, P3)', () => {
  it('a registered subdomain: the host is derived from it and the worker name, and nothing is registered', async () => {
    const w = world()
    expect((await dry(w, WD)).exitCode, said(w)).toBe(0)
    expect(hostOf(w)).toBe(WD_HOST)
    expect(w.fetched.some((u) => u.endsWith('/workers/subdomain'))).toBe(true)
    expect(w.state.subdomain.puts).toEqual([])
  })
  it('none and no flag: refused, naming the dashboard path and the flag; no PUT, no write', async () => {
    const w = world({ subdomain: null })
    const o = await run(w, WD)
    expect(o.exitCode).toBe(1)
    expect(said(w)).toContain('Workers & Pages')
    expect(said(w)).toContain('--register-workers-subdomain')
    expect(w.state.subdomain.puts).toEqual([])
    expect(w.state.configWrites).toBe(0)
    expect(w.writes()).toEqual([])
  })
  it('none with the flag: exactly one PUT with that name, then setup proceeds on the derived host', async () => {
    const w = world({ subdomain: null })
    const o = await run(w, [...WD, '--register-workers-subdomain', 'newsub'])
    expect(o.exitCode, said(w)).toBe(0)
    expect(w.state.subdomain.puts).toEqual(['newsub'])
    expect(hostOf(w)).toBe('vb-acme.newsub.workers.dev')
    expect(block(w).vars.PUBLIC_BASE_URL).toBe('https://vb-acme.newsub.workers.dev')
  })
  it.each([
    ['a partial Gmail group in the env file', 'GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\n'],
    ['a Gmail PUBLIC_BASE_URL naming another host', gmail('https://other.example.com')],
  ])('the registration is the first write: %s is refused (exit 1) and nothing is registered', async (_n, envText) => {
    const w = world({ subdomain: null, clerkEnvText: envText })
    const o = await run(w, [...WD, '--register-workers-subdomain', 'newsub'])
    expect(o.exitCode, said(w)).toBe(1)
    expect(w.state.subdomain.puts).toEqual([])
    expect(w.writes()).toEqual([])
  })
  it('a preflight that fails registers nothing', async () => {
    const w = world({ subdomain: null, denied: ['d1'] })
    const o = await run(w, [...WD, '--register-workers-subdomain', 'newsub'])
    expect(step(o, 'preflight').status).toBe('fail')
    expect(w.state.subdomain.puts).toEqual([])
  })
  it('a dry run with the flag: no PUT, reported as planned, the host still derived', async () => {
    const w = world({ subdomain: null })
    const o = await dry(w, [...WD, '--register-workers-subdomain', 'newsub'])
    expect(o.exitCode, said(w)).toBe(0)
    expect(w.state.subdomain.puts).toEqual([])
    expect(said(w)).toMatch(/would register.*newsub/)
    expect(hostOf(w)).toBe('vb-acme.newsub.workers.dev')
  })
  it('the flag while the account has a different subdomain: refused naming it, no PUT (setup never renames)', async () => {
    const w = world()
    const o = await run(w, [...WD, '--register-workers-subdomain', 'other'])
    expect(o.exitCode).toBe(1)
    expect(said(w)).toContain('team')
    expect(w.state.subdomain.puts).toEqual([])
    expect(w.state.configWrites).toBe(0)
  })
  it('the flag naming the subdomain the account already has is no rename: accepted, no PUT', async () => {
    const w = world()
    expect((await dry(w, [...WD, '--register-workers-subdomain', 'team'])).exitCode, said(w)).toBe(0)
    expect(w.state.subdomain.puts).toEqual([])
  })
  it('a malformed name is refused before any call', async () => {
    await expectRefused(
      world({ subdomain: null }),
      [...WD, '--register-workers-subdomain', 'Bad_Name'],
      ['--register-workers-subdomain'],
    )
  })
  it('a token that cannot read the subdomain: refused naming the permission', async () => {
    const w = world({ subdomainDenied: true })
    expect((await run(w, WD)).exitCode).toBe(1)
    expect(said(w)).toContain('Workers Scripts')
    expect(w.state.configWrites).toBe(0)
  })
  it('a renamed account subdomain on a recorded workers.dev instance is a host change: refused without --change-host, nothing written', async () => {
    const w = world({
      configText: withBlock({ name: 'vb-acme', workers_dev: true, vars: BA('https://vb-acme.old.workers.dev') }),
    })
    const o = await run(w, WD)
    expect(o.exitCode).toBe(1)
    expect(said(w)).toContain('--change-host')
    expect(w.state.configWrites).toBe(0)
    expect(w.writes()).toEqual([])
  })
  it('preflight in workers.dev mode makes no zone call and still checks D1, R2 and Workers; a custom domain still checks the zone', async () => {
    const w = world()
    const o = await dry(w, WD)
    expect(step(o, 'preflight').status).toBe('ok')
    expect(w.fetched.filter((u) => /\/zones\?/.test(u))).toEqual([])
    for (const p of ['/d1/database', '/r2/buckets', '/workers/scripts'])
      expect(
        w.fetched.some((u) => u.includes(p)),
        p,
      ).toBe(true)
    const c = world()
    await dry(c, [...NEW, '--api-host', HOST])
    expect(c.fetched.some((u) => /\/zones\?/.test(u))).toBe(true)
  })
})

describe('3. the record and the config (D12)', () => {
  it('better-auth: the env block has workers_dev true, no routes and the derived PUBLIC_BASE_URL', async () => {
    const w = world()
    await run(w, WD)
    const b = block(w)
    expect(b.workers_dev).toBe(true)
    expect(b.routes).toBeUndefined()
    expect(b.vars).toEqual(BA(WD_BASE))
    expect(b.name).toBe('vb-acme')
  })
  it('none: workers_dev true, no routes, no PUBLIC_BASE_URL (D2 writes it on better-auth only)', async () => {
    const w = world()
    await run(w, ['--env', 'acme', '--auth', 'none', '--workers-dev'])
    expect(block(w).workers_dev).toBe(true)
    expect(block(w).routes).toBeUndefined()
    expect(block(w).vars.PUBLIC_BASE_URL).toBeUndefined()
  })
  it('a custom-domain run still writes workers_dev false and the custom_domain route (the empty state)', async () => {
    const w = world()
    await run(w, [...NEW, '--api-host', HOST])
    expect(block(w).workers_dev).toBe(false)
    expect(block(w).routes).toEqual([{ pattern: HOST, custom_domain: true }])
  })
})

describe('4. one base URL and one verify bound (P1, P2)', () => {
  it('a full workers.dev run reads health, discovery and metadata on the derived host and uses the same base everywhere', async () => {
    const w = world({ ba: { signInMethods: ['password', 'google'] }, clerkEnvText: GOOGLE })
    const o = await fullRun(w, WD)
    expect(o.exitCode, said(w)).toBe(0)
    const worker = w.fetched.filter((u) => !u.startsWith('https://api.cloudflare.com/'))
    expect(worker.length).toBeGreaterThan(0)
    for (const u of worker) expect(u.startsWith(`${WD_BASE}/`), u).toBe(true)
    for (const p of ['/health', '/.well-known/vibase', '/.well-known/oauth-authorization-server/auth'])
      expect(worker, p).toContain(`${WD_BASE}${p}`)
    expect(
      w.logs.filter((l) => l.includes('/app/invite#token=')).every((l) => l.includes(`${WD_BASE}/app/invite#token=`)),
    ).toBe(true)
    expect(w.logs.some((l) => l.includes('/app/invite#token='))).toBe(true)
    expect(said(w)).toContain(`vibase login --server ${WD_BASE}`)
    expect(said(w)).toContain(`${WD_BASE}/auth/callback/google`)
  })
  it('the expected issuer is the derived base, never what the Worker says: another issuer fails verify', async () => {
    const w = world({ ba: { vibase: [{ status: 200, body: discoveryAnswer('https://other.example.com') }] } })
    const o = await fullRun(w, WD)
    expect(o.exitCode).toBe(1)
    expect(step(o, 'verify').detail).toContain(`${WD_BASE}/auth`)
  })
  it('a Gmail-group PUBLIC_BASE_URL equal to the derived base is accepted, one naming another host is refused', async () => {
    const ok = world({ clerkEnvText: gmail(WD_BASE) })
    expect((await run(ok, WD)).exitCode, said(ok)).toBe(0)
    expect(block(ok).vars.PUBLIC_BASE_URL).toBe(WD_BASE)
    const bad = world({ clerkEnvText: gmail('https://other.example.com') })
    const o = await run(bad, WD)
    expect(o.exitCode).toBe(1)
    expect(o.results).toEqual([])
    expect(said(bad)).toMatch(/PUBLIC_BASE_URL/)
    expect(bad.state.configWrites).toBe(0)
  })
  it("health current after 200 s, then discovery answering 5xx: fails by 300 s from verify's start, and says so", async () => {
    const w = world({ healthCurrentAfterMs: 200_000, ba: { vibase: [{ status: 500 }] } })
    await run(w, WD)
    w.logs.length = 0
    w.state.sleeps.length = 0
    const o = await run(w, WD)
    expect(o.exitCode).toBe(1)
    expect(step(o, 'verify').status).toBe('fail')
    expect(step(o, 'verify').detail).toContain('300s')
    expect(w.state.sleeps.reduce((a, b) => a + b, 0)).toBe(300_000)
  })
  it('health at once and discovery 5xx for 290 s still passes', async () => {
    const answer = { status: 200, body: discoveryAnswer(WD_BASE) }
    const w = world({ ba: { vibase: [...Array.from({ length: 29 }, () => ({ status: 500 })), answer] } })
    const o = await fullRun(w, WD)
    expect(o.exitCode, said(w)).toBe(0)
    expect(w.state.sleeps.reduce((a, b) => a + b, 0)).toBe(290_000)
  })
})

describe('5. --change-host (D14, P5)', () => {
  const CONSEQUENCES = ['sign in again', 'vibase login', 'reconnect MCP']
  it('without the flag a differing --api-host is refused naming the consequences, nothing written', async () => {
    const w = world({ configText: RECORD_WD })
    const before = w.state.configText
    const o = await run(w, [...NEW, '--api-host', HOST])
    expect(o.exitCode).toBe(1)
    for (const n of CONSEQUENCES) expect(said(w), n).toContain(n)
    expect(w.state.configText).toBe(before)
    expect(w.writes()).toEqual([])
  })
  it('from workers.dev: zone check, workers_dev kept, the route added, host and PUBLIC_BASE_URL rewritten, the consequences and the new Google redirect URI printed; the re-run is plain', async () => {
    const w = world({ clerkEnvText: GOOGLE })
    expect((await fullRun(w, WD)).exitCode, said(w)).toBe(0)
    w.logs.length = 0
    w.fetched.length = 0
    const o = await run(w, CHANGE)
    expect(o.stoppedAfterConfigWrite, said(w)).toBe(true)
    expect(w.fetched.some((u) => /\/zones\?name=/.test(u))).toBe(true)
    const b = block(w)
    expect(b.workers_dev).toBe(true)
    expect(b.routes).toEqual([{ pattern: HOST, custom_domain: true }])
    expect(b.vars.PUBLIC_BASE_URL).toBe(BASE)
    for (const n of CONSEQUENCES) expect(said(w), n).toContain(n)
    expect(said(w)).toContain(`${BASE}/auth/callback/google`)
    expect(said(w)).not.toContain('/oauth/callback/google')
    // the re-run with --api-host alone is a plain re-run: no flag needed, no consequence lines, verify on the new host
    w.logs.length = 0
    w.fetched.length = 0
    const again = await run(w, [...NEW, '--api-host', HOST])
    expect(again.exitCode, said(w)).toBe(0)
    expect(step(again, 'config:write').status).toBe('ok')
    expect(w.fetched).toContain(`${BASE}/health`)
    expect(said(w)).toContain(`vibase login --server ${BASE}`)
    expect(said(w)).not.toContain('sign in again')
  })
  it('a Gmail-only instance is told the Gmail callback, not the Better Auth Google sign-in one', async () => {
    const w = world({ clerkEnvText: gmail() })
    expect((await fullRun(w, WD)).exitCode, said(w)).toBe(0)
    w.logs.length = 0
    await run(w, CHANGE)
    expect(said(w)).toContain(`${BASE}/oauth/callback/google`)
    expect(said(w)).not.toContain('/auth/callback/google')
  })
  it('a missing zone for the new host is refused before any write', async () => {
    const w = world({ zones: [], configText: RECORD_WD })
    const o = await run(w, CHANGE)
    expect(step(o, 'preflight').status).toBe('fail')
    expect(w.state.configWrites).toBe(0)
    expect(w.writes()).toEqual([])
  })
  it('custom to custom: the old route is replaced, not kept, and a manual line names the old domain', async () => {
    const w = world({ configText: RECORD_CUSTOM })
    const o = await run(w, [...NEW, '--api-host', 'api2.acme.vibase.ai', '--change-host'])
    expect(o.stoppedAfterConfigWrite, said(w)).toBe(true)
    expect(block(w).routes).toEqual([{ pattern: 'api2.acme.vibase.ai', custom_domain: true }])
    expect(block(w).vars.PUBLIC_BASE_URL).toBe('https://api2.acme.vibase.ai')
    expect(said(w)).toMatch(new RegExp(`manual:[\\s\\S]*${HOST.replaceAll('.', '\\.')}[\\s\\S]*may still be attached`))
  })
  it('a dry run writes nothing and reports the change', async () => {
    const w = world()
    await fullRun(w, WD)
    const writes = w.state.configWrites
    const before = w.state.configText
    w.logs.length = 0
    const o = await dry(w, CHANGE)
    expect(o.exitCode, said(w)).toBe(0)
    expect(w.state.configWrites).toBe(writes)
    expect(w.state.configText).toBe(before)
    expect(said(w)).toContain(`host change: ${WD_HOST} -> ${HOST}`)
    for (const n of CONSEQUENCES) expect(said(w), n).toContain(n)
  })
})
