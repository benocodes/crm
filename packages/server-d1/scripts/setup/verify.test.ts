// OPS306 on `setup:remote`: verify on `better-auth` (D8, P1: the discovery and metadata checks and their retry), the next steps (D8), the Google redirect-URI line (D4, P2) and the
// no-email statement (D5, P3). The same obligations for `vibase-server setup` are in instance/setup-verify.test.ts. Everything runs against the setup kit's fake wrangler, Cloudflare
// API and fetch, with two real local D1s (CRM and control) behind the proxy.
import { readFileSync } from 'node:fs'
import { applyEdits, modify } from 'jsonc-parser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { runSetup } from './run.js'
import { VERIFY_BOUND_MS } from './steps.js'
import { NO_EMAIL_STATEMENT } from './verify-better-auth.js'
import type { BetterAuthScript } from './test/better-auth-answers.js'
import {
  EXPECTED_MIGRATIONS,
  FIXTURE_CONFIG_PATH,
  makeWorld,
  SHA,
  type World,
  type WorldOptions,
} from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const HOST = 'api.acme.vibase.ai'
const BASE = `https://${HOST}`
const OWNER = 'owner@example.com'
const ACME = ['--env', 'acme', '--api-host', HOST, '--owner-email', OWNER]
const fixture = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const VIBASE_URL = `${BASE}/.well-known/vibase`
const META_URL = `${BASE}/.well-known/oauth-authorization-server/auth`

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
const run = (w: World, argv: string[] = ACME) => runSetup(argv, CONFIRM, w.deps)
const step = (o: Awaited<ReturnType<typeof runSetup>>, name: string) => o.results.find((r) => r.step === name)!
const block = (b: Record<string, unknown>) =>
  applyEdits(
    fixture,
    modify(
      fixture,
      ['env', 'acme'],
      { name: 'vb-acme', ...b },
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    ),
  )
const BA_VARS = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE }
/** An instance that is deployed and migrated, so `--only verify` reaches verify's own work. */
const deployed = (o: Partial<WorldOptions> = {}, b: Record<string, unknown> = { vars: BA_VARS }): World =>
  world({ configText: block(b), deployedSha: SHA, applied: [...EXPECTED_MIGRATIONS], ...o })
const verifyOnly = (w: World, extra: string[] = []) => run(w, [...ACME, '--only', 'verify', ...extra])
const calls = (w: World, url: string) => w.fetched.filter((u) => u === url).length
const ba = (s: BetterAuthScript): Partial<WorldOptions> => ({ ba: s })
const ok200 = (body: unknown) => ({ status: 200, body })

/** The first run of a new instance writes the env block and stops ([[OPS65]] D10); the second one does the rest. */
async function fullRun(w: World) {
  const first = await run(w)
  expect(first.stoppedAfterConfigWrite, w.logs.join('\n')).toBe(true)
  w.logs.length = 0
  return run(w)
}

describe('1. verify on better-auth (D8, P1): the matrix', () => {
  it('success: discovery and metadata both read, verify ok', async () => {
    const w = deployed()
    const o = await verifyOnly(w)
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
    expect(calls(w, VIBASE_URL)).toBe(1)
    expect(calls(w, META_URL)).toBe(1)
  })

  it('a full first-time run ends in verify ok on the correct answers', async () => {
    const o = await fullRun(world())
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
  })

  it('discovery 500 then 200 within the bound: ok, after one wait', async () => {
    const w2 = deployed(
      ba({
        vibase: [
          { status: 500 },
          {
            status: 200,
            body: { auth: { provider: 'better-auth', issuer: `${BASE}/auth`, sign_in_methods: ['password'] } },
          },
        ],
      }),
    )
    const o = await verifyOnly(w2)
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
    expect(calls(w2, VIBASE_URL)).toBe(2)
    expect(w2.state.sleeps.length).toBeGreaterThanOrEqual(1)
  })

  it('metadata 500 then 200 within the bound: ok', async () => {
    const w = deployed(ba({ metadata: [{ status: 502 }, { status: 200, body: { issuer: `${BASE}/auth` } }] }))
    const o = await verifyOnly(w)
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
  })

  it('a connection failure then 200 within the bound: ok', async () => {
    const w = deployed(
      ba({
        vibase: [
          'throw',
          { status: 200, body: { auth: { provider: 'better-auth', issuer: `${BASE}/auth`, sign_in_methods: [] } } },
        ],
      }),
    )
    const o = await verifyOnly(w)
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
  })

  it('discovery 5xx past the bound: fail, naming the URL and the status, after the bound on the injected clock', async () => {
    const w = deployed(ba({ vibase: [{ status: 500 }] }))
    const o = await verifyOnly(w)
    const r = step(o, 'verify')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain(VIBASE_URL)
    expect(r.detail).toContain('500')
    expect(w.state.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(VERIFY_BOUND_MS)
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
      /auth\.issuer is https:\/\/other\.example\/auth, setup configured https:\/\/api\.acme\.vibase\.ai\/auth/,
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
    const w = deployed(ba(script))
    const o = await verifyOnly(w)
    const r = step(o, 'verify')
    expect(r.status, r.detail).toBe('fail')
    expect(r.detail).toMatch(re)
    expect(r.detail).toContain(BASE)
    expect(w.state.sleeps).toEqual([])
  })

  it('discovery 200 with the wrong content after an earlier 500: fail without waiting out the bound', async () => {
    const w = deployed(
      ba({
        vibase: [{ status: 500 }, ok200({ auth: { provider: 'better-auth', issuer: 'https://other.example/auth' } })],
      }),
    )
    const o = await verifyOnly(w)
    expect(step(o, 'verify').status).toBe('fail')
    expect(step(o, 'verify').detail).toMatch(/auth\.issuer/)
    expect(w.state.sleeps).toHaveLength(1)
    expect(calls(w, VIBASE_URL)).toBe(2)
  })

  it('a dry run with a 500: fail, read once, no retry and no wait', async () => {
    const w = deployed(ba({ vibase: [{ status: 500 }] }))
    const o = await verifyOnly(w, ['--dry-run'])
    const r = step(o, 'verify')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('500')
    expect(calls(w, VIBASE_URL)).toBe(1)
    expect(w.state.sleeps).toEqual([])
  })

  it('a dry run with correct answers reads both documents (they only read) and is ok', async () => {
    const w = deployed()
    const o = await verifyOnly(w, ['--dry-run'])
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
    expect(calls(w, META_URL)).toBe(1)
  })

  it('the expected issuer is the recorded PUBLIC_BASE_URL host, not anything a response says: a Worker reporting another host fails', async () => {
    const w = deployed(
      ba({ vibase: [ok200({ auth: { provider: 'better-auth', issuer: 'https://api.elsewhere.vibase.ai/auth' } })] }),
    )
    expect(step(await verifyOnly(w), 'verify').status).toBe('fail')
  })

  it('none and clerk verify do not read the metadata document', async () => {
    const w = world({
      configText: block({ vars: { AUTH_PROVIDER: '' } }),
      deployedSha: SHA,
      applied: [...EXPECTED_MIGRATIONS],
    })
    const o = await runSetup([...ACME, '--auth', 'none', '--only', 'verify'], CONFIRM, w.deps)
    expect(step(o, 'verify').status, step(o, 'verify').detail).toBe('ok')
    expect(calls(w, META_URL)).toBe(0)
    expect(calls(w, VIBASE_URL)).toBe(0)
  })
})

/** The lines of verify's result. */
const lines = (o: Awaited<ReturnType<typeof runSetup>>) => step(o, 'verify').lines ?? []

describe('2. the next steps on better-auth (D8)', () => {
  const CLAIM = 'open the owner invitation link printed above by the bootstrap step; it is shown once'

  it('the run whose bootstrap issued a link: API, the claim line, login, MCP, the no-email statement, then the operator hint, in that order', async () => {
    const w = world()
    const o = await fullRun(w)
    const l = lines(o)
    expect(l.slice(0, 5)).toEqual([
      `API: ${BASE}`,
      CLAIM,
      `vibase login --server ${BASE}`,
      `MCP: ${BASE}/mcp`,
      NO_EMAIL_STATEMENT,
    ])
    expect(l[5]).toMatch(/^this env is bootstrapped; create agents and keys through agents\.create/)
  })

  it("the invitation URL and token appear in the bootstrap step's lines only, never in verify's", async () => {
    const w = world()
    const o = await fullRun(w)
    const token = /\/invite#token=([A-Za-z0-9_-]+)/.exec((step(o, 'bootstrap').lines ?? []).join('\n'))?.[1]
    expect(token).toBeTruthy()
    expect(lines(o).join('\n')).not.toContain(token!)
    expect(lines(o).join('\n')).not.toContain('/invite')
  })

  it('a re-run (owner invitation pending): no claim line', async () => {
    const w = world()
    await fullRun(w)
    w.logs.length = 0
    const o = await run(w)
    expect(step(o, 'bootstrap').status).toBe('ok')
    expect(lines(o)).not.toContain(CLAIM)
    expect(lines(o)[0]).toBe(`API: ${BASE}`)
    expect(lines(o)[1]).toBe(`vibase login --server ${BASE}`)
  })

  it('--only verify: no claim line, even with --owner-email given', async () => {
    const o = await verifyOnly(deployed())
    expect(lines(o)).not.toContain(CLAIM)
    expect(lines(o).slice(0, 3)).toEqual([`API: ${BASE}`, `vibase login --server ${BASE}`, `MCP: ${BASE}/mcp`])
  })

  it("none: the next steps are today's (API, then the hint) with no login, MCP, claim or statement", async () => {
    const w = world({
      configText: block({ vars: { AUTH_PROVIDER: '' } }),
      deployedSha: SHA,
      applied: [...EXPECTED_MIGRATIONS],
    })
    const o = await runSetup([...ACME, '--auth', 'none', '--only', 'verify'], CONFIRM, w.deps)
    const l = lines(o)
    expect(l[0]).toBe(`API: ${BASE}`)
    expect(l.join('\n')).not.toMatch(/MCP:|vibase login|invitation link|Email is not configured/)
  })
})

describe('3. the Google line (D4, P2)', () => {
  const REDIRECT = `manual add the redirect URI ${BASE}/auth/callback/google to the Google OAuth client`
  it('sign_in_methods contains google: the line is there, with the PUBLIC_BASE_URL redirect URI, and the step stays ok', async () => {
    const o = await verifyOnly(deployed(ba({ signInMethods: ['password', 'google'] })))
    expect(step(o, 'verify').status).toBe('ok')
    expect(lines(o)).toContain(REDIRECT)
    const l = lines(o)
    expect(l.indexOf(REDIRECT)).toBe(l.indexOf(`MCP: ${BASE}/mcp`) + 1)
  })
  it('sign_in_methods is ["password"]: no Google line, whatever the secrets file or the Worker secrets hold', async () => {
    const o = await verifyOnly(
      deployed({
        ...ba({ signInMethods: ['password'] }),
        secrets: ['AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET'],
      }),
    )
    expect(lines(o).join('\n')).not.toContain('/auth/callback/google')
  })
})

describe('4. the no-email statement (D5, P3)', () => {
  const emailBlock = { send_email: [{ name: 'EMAIL' }] }
  const FROM = { AUTH_EMAIL_FROM: 'invites@example.com' }
  const stmt = (o: Awaited<ReturnType<typeof runSetup>>) => lines(o).includes(NO_EMAIL_STATEMENT)

  it("the text is CORE243 D16's in full, with its owner sentence (OPS307 D5)", () => {
    expect(NO_EMAIL_STATEMENT).toBe(
      "Email is not configured: there is no self-service password reset. A member who forgets their password gets a reset link from an owner; an owner gets one from `vibase-server owner-reset` (needs this instance's Cloudflare credentials). Invitation links are printed for you to send.",
    )
    expect(NO_EMAIL_STATEMENT).toMatch(/an owner gets one from `vibase-server owner-reset`/)
  })
  it('the empty state prints it', async () => {
    expect(stmt(await verifyOnly(deployed()))).toBe(true)
  })
  it('only the binding: it prints', async () => {
    expect(stmt(await verifyOnly(deployed({}, { ...emailBlock, vars: BA_VARS })))).toBe(true)
  })
  it('only AUTH_EMAIL_FROM: it prints', async () => {
    expect(stmt(await verifyOnly(deployed({}, { vars: { ...BA_VARS, ...FROM } })))).toBe(true)
  })
  it('a binding of another name plus AUTH_EMAIL_FROM: it prints', async () => {
    expect(
      stmt(await verifyOnly(deployed({}, { send_email: [{ name: 'MAIL' }], vars: { ...BA_VARS, ...FROM } }))),
    ).toBe(true)
  })
  it('both values recorded: it is absent', async () => {
    expect(stmt(await verifyOnly(deployed({}, { ...emailBlock, vars: { ...BA_VARS, ...FROM } })))).toBe(false)
  })
  it('never on none', async () => {
    const w = world({
      configText: block({ vars: { AUTH_PROVIDER: '' } }),
      deployedSha: SHA,
      applied: [...EXPECTED_MIGRATIONS],
    })
    expect(stmt(await runSetup([...ACME, '--auth', 'none', '--only', 'verify'], CONFIRM, w.deps))).toBe(false)
  })
})
