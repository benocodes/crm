// OPS306 on `vibase-server setup`: verify on `better-auth` (D8, P1), the next steps (D8), the Google redirect-URI line (D4, P2) and the no-email statement (D5, P3). The same
// obligations for `setup:remote` are in setup/verify.test.ts. Everything runs against the instance kit's fake wrangler and fetch, a real secrets and settings file on disk,
// and two real local D1s (CRM and control).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { NO_EMAIL_STATEMENT } from '../setup/verify-better-auth.js'
import type { BetterAuthScript } from '../setup/test/better-auth-answers.js'
import { ALL_MIGRATIONS, API_HOST, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { CONTROL_ALL, CONTROL_UUID, SECRETS_TEXT, UUID, cleanup, controlSettings } from './test-kit.js'

const BASE = `https://${API_HOST}`
const OWNER = 'owner@example.com'
const ARGS = ['--env', 'demo', '--api-host', API_HOST, '--owner-email', OWNER]
const VIBASE_URL = `${BASE}/.well-known/vibase`
const META_URL = `${BASE}/.well-known/oauth-authorization-server/auth`
const BA_VARS = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, CORS_ALLOWED_ORIGINS: '' }
const CLAIM = 'open the owner invitation link printed above by the bootstrap step; it is shown once'

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
const run = (s: SetupWorld, argv: string[] = ARGS) => runSetup(argv, s.w.deps)
const row = (s: SetupWorld, name: string) => s.rows().find((r) => r.step === name)!
/** The package's own version, which verify waits for. */
const pkgVersion = (s: SetupWorld): string =>
  (JSON.parse(readFileSync(join(s.w.pkg.dir, 'release.json'), 'utf8')) as { version: string }).version
/** An instance that is recorded, migrated and deployed at the package's version, so `--only verify` reaches verify's own work. */
function deployed(o: { ba?: BetterAuthScript; vars?: Record<string, string> } = {}): SetupWorld {
  const s = world({
    settings: controlSettings({ vars: o.vars ?? BA_VARS }),
    secretsText: SECRETS_TEXT,
    sim: {
      d1s: [
        { uuid: UUID, name: 'vault-demo' },
        { uuid: CONTROL_UUID, name: 'ctl-recorded-name' },
      ],
      r2s: ['vault-demo-bodies'],
      applied: [...ALL_MIGRATIONS],
      controlApplied: [...CONTROL_ALL],
      ...(o.ba ? { ba: o.ba } : {}),
    },
  })
  s.sim.deployed = { version: pkgVersion(s), commit: 'c' }
  return s
}
const verifyOnly = (s: SetupWorld, extra: string[] = []) => run(s, [...ARGS, '--only', 'verify', ...extra])
const calls = (s: SetupWorld, url: string) => s.w.fetchUrls.filter((u) => u === url).length
const ok200 = (body: unknown) => ({ status: 200, body })
/** The lines under verify's row (printed indented). */
function lines(s: SetupWorld): string[] {
  const i = s.w.out.findIndex((l) => /^(ok|fail|blocked)\s+verify\b/.test(l))
  const out: string[] = []
  for (const l of s.w.out.slice(i + 1)) {
    if (!/^\s{4,}\S/.test(l)) break
    out.push(l.trim())
  }
  return out
}

describe('1. verify on better-auth (D8, P1): the matrix', () => {
  it('success: discovery and metadata both read, verify ok', async () => {
    const s = deployed()
    expect(await verifyOnly(s), s.w.all()).toBe(0)
    expect(row(s, 'verify').status).toBe('ok')
    expect(calls(s, VIBASE_URL)).toBe(1)
    expect(calls(s, META_URL)).toBe(1)
  })

  it('a full first-time run ends in verify ok on the correct answers', async () => {
    const s = world()
    expect(await run(s), s.w.all()).toBe(0)
    expect(row(s, 'verify').status).toBe('ok')
  })

  it('discovery 500 then 200 within the bound: ok, after one wait', async () => {
    const s = deployed({
      ba: {
        vibase: [
          { status: 500 },
          {
            status: 200,
            body: { auth: { provider: 'better-auth', issuer: `${BASE}/auth`, sign_in_methods: ['password'] } },
          },
        ],
      },
    })
    const clock0 = s.w.clock.t
    expect(await verifyOnly(s), s.w.all()).toBe(0)
    expect(calls(s, VIBASE_URL)).toBe(2)
    expect(s.w.clock.t - clock0).toBeGreaterThanOrEqual(10_000)
  })

  it('metadata 500 then 200 within the bound: ok', async () => {
    const s = deployed({ ba: { metadata: [{ status: 502 }, { status: 200, body: { issuer: `${BASE}/auth` } }] } })
    expect(await verifyOnly(s), s.w.all()).toBe(0)
  })

  it('a connection failure then 200 within the bound: ok', async () => {
    const s = deployed({
      ba: {
        vibase: [
          'throw',
          { status: 200, body: { auth: { provider: 'better-auth', issuer: `${BASE}/auth`, sign_in_methods: [] } } },
        ],
      },
    })
    expect(await verifyOnly(s), s.w.all()).toBe(0)
  })

  it('discovery 5xx past the bound: exit 3, naming the URL and the status, after the bound on the injected clock', async () => {
    const s = deployed({ ba: { vibase: [{ status: 500 }] } })
    const clock0 = s.w.clock.t
    expect(await verifyOnly(s)).toBe(3)
    expect(row(s, 'verify').status).toBe('fail')
    expect(row(s, 'verify').detail).toContain(VIBASE_URL)
    expect(row(s, 'verify').detail).toContain('500')
    expect(s.w.clock.t - clock0).toBeGreaterThanOrEqual(300_000)
  })

  const FAIL: [string, BetterAuthScript, RegExp][] = [
    ['auth null (the Worker is still on none)', { vibase: [ok200({ auth: null })] }, /no auth provider/],
    [
      'auth.provider is clerk',
      { vibase: [ok200({ auth: { provider: 'clerk', issuer: `${BASE}/auth` } })] },
      /auth\.provider is clerk/,
    ],
    [
      'wrong auth.issuer',
      { vibase: [ok200({ auth: { provider: 'better-auth', issuer: 'https://other.example/auth' } })] },
      /auth\.issuer is https:\/\/other\.example\/auth, setup configured https:\/\/api\.demo\.invalid\/auth/,
    ],
    ['metadata 404', { metadata: [{ status: 404 }] }, /oauth-authorization-server\/auth answered 404/],
    [
      'metadata issuer differs',
      { metadata: [ok200({ issuer: 'https://other.example/auth' })] },
      /oauth-authorization-server\/auth disagrees: issuer is https:\/\/other\.example\/auth/,
    ],
    ['discovery 404', { vibase: [{ status: 404 }] }, /\.well-known\/vibase answered 404/],
  ]
  it.each(FAIL)('%s: fail at once, naming the URL and what differed, with no wait', async (_n, script, re) => {
    const s = deployed({ ba: script })
    const clock0 = s.w.clock.t
    expect(await verifyOnly(s)).toBe(3)
    expect(row(s, 'verify').status).toBe('fail')
    expect(row(s, 'verify').detail).toMatch(re)
    expect(row(s, 'verify').detail).toContain(BASE)
    expect(s.w.clock.t).toBe(clock0)
  })

  it('discovery 200 with the wrong content after an earlier 500: fail without waiting out the bound', async () => {
    const s = deployed({
      ba: {
        vibase: [{ status: 500 }, ok200({ auth: { provider: 'better-auth', issuer: 'https://other.example/auth' } })],
      },
    })
    const clock0 = s.w.clock.t
    expect(await verifyOnly(s)).toBe(3)
    expect(row(s, 'verify').detail).toMatch(/auth\.issuer/)
    expect(calls(s, VIBASE_URL)).toBe(2)
    expect(s.w.clock.t - clock0).toBe(10_000)
  })

  it('a dry run with a 500: fail, read once, no retry and no wait', async () => {
    const s = deployed({ ba: { vibase: [{ status: 500 }] } })
    const clock0 = s.w.clock.t
    expect(await verifyOnly(s, ['--dry-run'])).not.toBe(0)
    expect(row(s, 'verify').status).toBe('fail')
    expect(row(s, 'verify').detail).toContain('500')
    expect(calls(s, VIBASE_URL)).toBe(1)
    expect(s.w.clock.t).toBe(clock0)
  })

  it('a dry run with correct answers reads both documents (they only read) and is ok', async () => {
    const s = deployed()
    expect(await verifyOnly(s, ['--dry-run']), s.w.all()).toBe(0)
    expect(calls(s, META_URL)).toBe(1)
  })

  it('none verify reads neither document', async () => {
    const s = deployed({ vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' } })
    expect(await run(s, [...ARGS, '--auth', 'none', '--only', 'verify']), s.w.all()).toBe(0)
    expect(calls(s, META_URL)).toBe(0)
    expect(calls(s, VIBASE_URL)).toBe(0)
  })
})

describe('2. the next steps on better-auth (D8)', () => {
  it('the run whose bootstrap issued a link: API, the claim line, login, MCP, the no-email statement, then the operator hint, in that order', async () => {
    const s = world()
    expect(await run(s), s.w.all()).toBe(0)
    const l = lines(s)
    expect(l.slice(0, 5)).toEqual([
      `API: ${BASE}`,
      CLAIM,
      `vibase login --server ${BASE}`,
      `MCP: ${BASE}/mcp`,
      NO_EMAIL_STATEMENT,
    ])
    expect(l[5]).toMatch(/^no operator key was created in this run/)
  })

  it("the invitation URL and token appear in the bootstrap step's lines only, never in verify's", async () => {
    const s = world()
    await run(s)
    const token = /\/invite#token=([A-Za-z0-9_-]+)/.exec(s.w.out.join('\n'))?.[1]
    expect(token).toBeTruthy()
    expect(lines(s).join('\n')).not.toContain(token!)
    expect(lines(s).join('\n')).not.toContain('/invite')
  })

  it('a re-run (owner invitation pending): no claim line', async () => {
    const s = world()
    await run(s)
    s.w.out.length = 0
    await s.sync()
    expect(await run(s), s.w.all()).toBe(0)
    expect(row(s, 'bootstrap').status).toBe('ok')
    expect(lines(s)).not.toContain(CLAIM)
    expect(lines(s).slice(0, 2)).toEqual([`API: ${BASE}`, `vibase login --server ${BASE}`])
  })

  it('--only verify: no claim line, even with --owner-email given', async () => {
    const s = deployed()
    await verifyOnly(s)
    expect(lines(s)).not.toContain(CLAIM)
    expect(lines(s).slice(0, 3)).toEqual([`API: ${BASE}`, `vibase login --server ${BASE}`, `MCP: ${BASE}/mcp`])
  })

  it("none: the next steps are today's (API, then the hint) with no login, MCP, claim or statement", async () => {
    const s = deployed({ vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' } })
    await run(s, [...ARGS, '--auth', 'none', '--only', 'verify'])
    expect(lines(s)[0]).toBe(`API: ${BASE}`)
    expect(lines(s).join('\n')).not.toMatch(/MCP:|vibase login|invitation link|Email is not configured/)
  })
})

describe('3. the Google line (D4, P2)', () => {
  const REDIRECT = `manual add the redirect URI ${BASE}/auth/callback/google to the Google OAuth client`
  it('sign_in_methods contains google: the line is there, right after MCP, and the step stays ok', async () => {
    const s = deployed({ ba: { signInMethods: ['password', 'google'] } })
    expect(await verifyOnly(s), s.w.all()).toBe(0)
    const l = lines(s)
    expect(l).toContain(REDIRECT)
    expect(l.indexOf(REDIRECT)).toBe(l.indexOf(`MCP: ${BASE}/mcp`) + 1)
  })
  it('sign_in_methods is ["password"]: no Google line, whatever the Worker secrets hold', async () => {
    const s = deployed({ ba: { signInMethods: ['password'] } })
    s.sim.secrets.push('AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET')
    await verifyOnly(s)
    expect(lines(s).join('\n')).not.toContain('/auth/callback/google')
  })
})

describe('4. the no-email statement (D5, P3)', () => {
  const stmt = (s: SetupWorld) => lines(s).includes(NO_EMAIL_STATEMENT)
  it("the text is CORE243 D16's in full, with its owner sentence (OPS307 D5)", () => {
    expect(NO_EMAIL_STATEMENT).toBe(
      "Email is not configured: there is no self-service password reset. A member who forgets their password gets a reset link from an owner; an owner gets one from `vibase-server owner-reset` (needs this instance's Cloudflare credentials). Invitation links are printed for you to send.",
    )
    expect(NO_EMAIL_STATEMENT).toMatch(/an owner gets one from `vibase-server owner-reset`/)
  })
  it('the empty state prints it', async () => {
    const s = deployed()
    await verifyOnly(s)
    expect(stmt(s)).toBe(true)
  })
  it('the settings file cannot hold the send_email binding, so the statement always prints on better-auth, even with AUTH_EMAIL_FROM set as a variable', async () => {
    const s = deployed({ vars: { ...BA_VARS, AUTH_EMAIL_FROM: 'invites@example.com' } })
    await verifyOnly(s)
    expect(stmt(s)).toBe(true)
  })
  it('never on none', async () => {
    const s = deployed({ vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' } })
    await run(s, [...ARGS, '--auth', 'none', '--only', 'verify'])
    expect(stmt(s)).toBe(false)
  })
})
