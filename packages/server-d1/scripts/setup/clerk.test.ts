// `setup:remote --auth clerk` ([[OPS87]] charter obligations 1-13), against fakes only: the fake Clerk (test/clerk-world.ts), cycle 1's fake world.
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SCOPE_POLICY, createVaultRegistry, toProviderScope } from '@vault/api'
import { execute } from '@vault/storage'
import { d1Binding } from '@vault/storage-d1'
import { parse } from 'jsonc-parser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initDeploymentOperation, readDeployment } from '../../src/init-deployment.js'
import { bootstrapD1 } from '../../src/bootstrap-d1.js'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { runSetup, type SetupOutcome } from './run.js'
import { ISSUER, OWNER_EMAIL, PK_TEST, SK_LIVE_SENTINEL, SK_TEST, jwkFor, makeClerk, type ClerkOptions, type FakeClerk } from './test/clerk-world.js'
import { EXPECTED_MIGRATIONS, REAL_CONFIG_PATH, SHA, isWriteCommand, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const BASE = ['--env', 'acme', '--api-host', 'api.acme.vibase.ai', '--owner-email', OWNER_EMAIL]
const realConfig = readFileSync(REAL_CONFIG_PATH, 'utf8')
const states = (o: SetupOutcome) => o.results.map((r) => `${r.step}:${r.status}`)
const text = (o: SetupOutcome, step = 'clerk') => {
  const r = o.results.find((x) => x.step === step)!
  return [r.detail, ...(r.lines ?? [])].join('\n')
}

const declared = createVaultRegistry().declaredScopes()
const cliScopes = [...declared.map(toProviderScope), 'offline_access']
const readScopes = declared.filter((s) => SCOPE_POLICY[s]?.agentGrantable === true && s.split(':')[1] === 'read').map(toProviderScope)
const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join()

let db: WorkerD1
beforeAll(async () => {
  db = await openWorkerD1()
})
afterAll(async () => {
  await db.dispose()
})
beforeEach(async () => {
  await db.reset()
})

function setup(c: ClerkOptions = {}, o: Partial<WorldOptions> = {}): { clerk: FakeClerk; w: World; opts: WorldOptions } {
  const clerk = makeClerk(c)
  const opts: WorldOptions = { d1: db.d1, clerk, ...o }
  return { clerk, w: makeWorld(opts), opts }
}
/** An instance already as setup wants it (apart from the origins), so a row under test is the only thing that can write. */
const settled = (c: ClerkOptions = {}): ClerkOptions => ({
  settings: { dynamic_oauth_client_registration: true, default_scopes: [...readScopes].reverse(), oauth_jwt_access_tokens: true },
  apps: [{ scopes: cliScopes.join(' ') }],
  users: [{ id: 'user_1', object: 'user', email_addresses: [{ email_address: OWNER_EMAIL }], public_metadata: { vibase_role: 'owner' } }],
  ...c,
})
const run = async (w: World, clerk: FakeClerk, args: string[], env: NodeJS.ProcessEnv = CONFIRM) => {
  const o = await runSetup(args, env, w.deps)
  expect(clerk.violations, 'a request outside the desired-state table (D25, D33)').toEqual([])
  return o
}
/** `wrangler.jsonc` with `env.acme` as the first run writes it, for runs that start from the later steps. */
const acmeConfig = async (clientId = 'client_1') => {
  const { reconcileEnvBlock } = await import('./config-editor.js')
  return reconcileEnvBlock(realConfig, {
    env: 'acme', workerName: 'vault-acme', d1Name: 'vault-acme', d1Id: '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b', r2Name: 'vault-acme-bodies', apiHost: 'api.acme.vibase.ai', corsOrigins: '',
    authVars: { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: PK_TEST, CLERK_AUTHORIZED_PARTIES: 'https://api.acme.vibase.ai', AUTH_CLI_CLIENT_ID: clientId },
  }).text
}
const onlyClerk = (extra: string[] = []) => [...BASE, '--only', 'clerk', ...extra]
const settingsWrites = (c: FakeClerk) => c.writes().filter((r) => r.path.startsWith('/v1/instance/oauth_application_settings'))
const appWrites = (c: FakeClerk) => c.writes().filter((r) => r.path.startsWith('/v1/oauth_applications'))

describe('1. key source (D34): refusals before any request or subprocess', () => {
  const cases: [string, Partial<WorldOptions>, RegExp][] = [
    ['the root .env', { clerkFileStatus: 'root-env' }, /root \.env/],
    ['a file git does not ignore', { clerkFileStatus: 'not-ignored' }, /ignore/],
    ['a missing file', { clerkEnvText: null }, /not found|missing|no such/i],
    ['a file without CLERK_SECRET_KEY', { clerkEnvText: `VITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n` }, /CLERK_SECRET_KEY/],
  ]
  it.each(cases)('%s', async (_n, o, re) => {
    for (const args of [BASE, [...BASE, '--dry-run']]) {
      const { clerk, w } = setup({}, o)
      const out = await runSetup(args, CONFIRM, w.deps)
      expect(out.exitCode).toBe(1)
      expect(w.logs.join('\n')).toMatch(re)
      expect(w.argv).toEqual([])
      expect(w.fetched).toEqual([])
      expect(clerk.requests).toEqual([])
    }
  })
  it('asks for the default .env.<env> when no --clerk-env-file is given, and for the named file otherwise', async () => {
    const a = setup()
    await runSetup([...BASE, '--only', 'clerk', '--dry-run'], {}, a.w.deps)
    expect(a.w.probes).toEqual([{ arg: undefined, envName: 'acme' }])
    const b = setup()
    await runSetup([...BASE, '--only', 'clerk', '--dry-run', '--clerk-env-file', '.env.dev'], {}, b.w.deps)
    expect(b.w.probes).toEqual([{ arg: '.env.dev', envName: 'acme' }])
  })
})

describe('2. the process environment is never read', () => {
  it('a sentinel sk_live_ in process.env and procEnv never reaches a request, argv, stdin or a log; the file key is used', async () => {
    const saved = { sk: process.env.CLERK_SECRET_KEY, pk: process.env.CLERK_PUBLISHABLE_KEY, vpk: process.env.VITE_CLERK_PUBLISHABLE_KEY }
    process.env.CLERK_SECRET_KEY = SK_LIVE_SENTINEL
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_live_SENTINEL'
    process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_live_SENTINEL'
    try {
      const { clerk, w } = setup()
      const o = await run(w, clerk, onlyClerk(), { ...CONFIRM, CLERK_SECRET_KEY: SK_LIVE_SENTINEL, CLERK_PUBLISHABLE_KEY: 'pk_live_SENTINEL' })
      expect(o.exitCode).toBe(0)
      expect(clerk.requests.length).toBeGreaterThan(0)
      for (const r of clerk.requests) if (r.path.startsWith('/v1/') && r.headers.authorization) expect(r.headers.authorization).toBe(`Bearer ${SK_TEST}`)
      expect(JSON.stringify(clerk.requests)).not.toContain('SENTINEL')
      expect(w.surface()).not.toContain('SENTINEL')
      expect(w.fetched.join('\n')).not.toContain('SENTINEL')
    } finally {
      for (const [k, v] of [['CLERK_SECRET_KEY', saved.sk], ['CLERK_PUBLISHABLE_KEY', saved.pk], ['VITE_CLERK_PUBLISHABLE_KEY', saved.vpk]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('3. kinds and --clerk-production (D35, D36): refusals before any request, dry runs included', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  const PK_LIVE = `pk_live_${b64('clerk.acme.example$')}`
  const cases: [string, string, string[], RegExp][] = [
    ['sk_live_ without the flag', `CLERK_SECRET_KEY=${SK_LIVE_SENTINEL}\nCLERK_PUBLISHABLE_KEY=${PK_LIVE}\n`, [], /--clerk-production/],
    ['the flag with sk_test_', `CLERK_SECRET_KEY=${SK_TEST}\nCLERK_PUBLISHABLE_KEY=${PK_TEST}\n`, ['--clerk-production'], /development/],
    ['mismatched kinds', `CLERK_SECRET_KEY=${SK_TEST}\nCLERK_PUBLISHABLE_KEY=${PK_LIVE}\n`, [], /different|mismatch/i],
    ['a malformed key', `CLERK_SECRET_KEY=sk_wrong\nCLERK_PUBLISHABLE_KEY=${PK_TEST}\n`, [], /sk_test_|sk_live_/],
  ]
  it.each(cases)('%s', async (_n, envText, extra, re) => {
    for (const mode of [[], ['--dry-run']]) {
      const { clerk, w } = setup({}, { clerkEnvText: envText })
      const out = await runSetup([...BASE, ...extra, ...mode], CONFIRM, w.deps)
      expect(out.exitCode).toBe(1)
      expect(w.logs.join('\n')).toMatch(re)
      expect(clerk.requests).toEqual([])
      expect(w.fetched).toEqual([])
      expect(w.argv).toEqual([])
    }
  })
  it('prints the instance kind (development warning) and issuer before the plan, never a key', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, onlyClerk(['--dry-run']), {})
    const log = w.logs.join('\n')
    expect(log).toMatch(/development/i)
    expect(log).toContain(ISSUER)
    expect(log).not.toContain(SK_TEST)
    expect(log).not.toContain(PK_TEST)
    expect(log.indexOf(ISSUER)).toBeLessThan(log.search(/^(ok|create|update|fail|manual)\s+clerk\s/m))
  })
})

describe('4. two instances (D35)', () => {
  it('unequal JWKS kid sets are a fail naming the mismatch, with no Clerk write', async () => {
    const { clerk, w } = setup({ bapiKids: ['ins_a'], issuerKids: ['ins_b'] })
    const o = await run(w, clerk, onlyClerk())
    expect(states(o)).toEqual(['clerk:fail'])
    expect(text(o)).toMatch(/different Clerk instances/)
    expect(clerk.writes()).toEqual([])
  })
  it('equal sets pass', async () => {
    const { clerk, w } = setup({ bapiKids: ['k1', 'k2'], issuerKids: ['k2', 'k1'] })
    expect(states(await run(w, clerk, onlyClerk()))[0]).not.toBe('clerk:fail')
  })
  it('the issuer is confirmed against openid-configuration: a different issuer there is a fail', async () => {
    const { clerk, w } = setup()
    const real = w.deps.fetch
    w.deps.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).endsWith('/.well-known/openid-configuration') ? new Response(JSON.stringify({ issuer: 'https://other.example' })) : real(i, init))) as typeof fetch
    const o = await runSetup(onlyClerk(), CONFIRM, w.deps)
    expect(states(o)).toEqual(['clerk:fail'])
    expect(text(o)).toMatch(/issuer/)
  })
})

describe('5. desired-state rows', () => {
  describe('C1 sign-up mode (D27)', () => {
    it('public is a fail printing the dashboard path, and the run stops', async () => {
      const { clerk, w } = setup(settled({ signUpMode: 'public' }))
      const o = await run(w, clerk, onlyClerk())
      expect(states(o)).toEqual(['clerk:fail'])
      expect(text(o)).toMatch(/^C1\s+fail/m)
      expect(text(o)).toMatch(/Restricted/)
    })
    it.each(['restricted', 'waitlist'] as const)('%s is ok', async (mode) => {
      const { clerk, w } = setup(settled({ signUpMode: mode }))
      expect(text(await run(w, clerk, onlyClerk()))).toMatch(/^C1\s+ok/m)
    })
    it('a refused read is manual, not fail', async () => {
      const { clerk, w } = setup(settled({ fapiEnvironmentStatus: 401 }))
      const o = await run(w, clerk, onlyClerk())
      expect(text(o)).toMatch(/^C1\s+manual/m)
      expect(o.results[0]!.status).not.toBe('fail')
    })
  })

  describe('C2 organizations (D32): read only', () => {
    it('enabled is a warning and never written', async () => {
      const { clerk, w } = setup(settled({ organizations: true }))
      const o = await run(w, clerk, onlyClerk())
      expect(text(o)).toMatch(/^C2\s.*warning/im)
      expect(o.results[0]!.status).not.toBe('fail')
      expect(clerk.writes()).toEqual([])
    })
    it.each([402, 404] as const)('%s counts as off', async (code) => {
      const { clerk, w } = setup(settled({ organizations: code }))
      const o = await run(w, clerk, onlyClerk())
      expect(text(o)).toMatch(/^C2\s+ok/m)
      expect(text(o)).not.toMatch(/^C2\s.*warning/im)
    })
  })

  describe('C3 is never ok (obligation 6)', () => {
    const cases: [string, ClerkOptions, string[]][] = [
      ['a settled instance', settled(), []],
      ['an empty instance', {}, []],
      ['a dry run', {}, ['--dry-run']],
    ]
    it.each(cases)('%s: reported manual, listed in the manual section', async (_n, c, extra) => {
      const { clerk, w } = setup(c)
      const o = await run(w, clerk, onlyClerk(extra), extra.length ? {} : CONFIRM)
      expect(text(o)).toMatch(/^C3\s+manual/m)
      expect(text(o)).not.toMatch(/^C3\s+ok/m)
      expect(o.results[0]!.manual?.join('\n')).toMatch(/C3/)
      expect(w.logs.join('\n')).toMatch(/manual:[\s\S]*C3/)
    })
    it('the Dashboard instruction carries the claim to add', async () => {
      const { clerk, w } = setup()
      expect(text(await run(w, clerk, onlyClerk(['--dry-run']), {}))).toContain('{{user.public_metadata.vibase_role}}')
    })
    it('sign-in methods are manual too', async () => {
      const { clerk, w } = setup(settled())
      expect(text(await run(w, clerk, onlyClerk()))).toMatch(/sign-in/i)
    })
  })

  describe('C4 allowed origins (D20, D32): union, never removed', () => {
    const ORIGINS = ['--web-origin', 'https://app.example.com', '--extra-origin', 'https://b.example.com']
    it('sends the union of the present list and the desired one, and reports the owner entries as extra', async () => {
      const { clerk, w } = setup(settled({ allowedOrigins: ['https://owner-added.example'] }))
      const o = await run(w, clerk, onlyClerk(ORIGINS))
      const patch = clerk.writes().filter((r) => r.path === '/v1/instance')
      expect(patch).toHaveLength(1)
      expect([...((patch[0]!.body as { allowed_origins: string[] }).allowed_origins)].sort()).toEqual(['https://app.example.com', 'https://b.example.com', 'https://owner-added.example'])
      expect(clerk.state.allowedOrigins).toContain('https://owner-added.example')
      expect(text(o)).toMatch(/extra.*owner-added\.example/is)
    })
    it('nothing to add: no PATCH', async () => {
      const { clerk, w } = setup(settled({ allowedOrigins: ['https://app.example.com', 'https://b.example.com'] }))
      await run(w, clerk, onlyClerk(ORIGINS))
      expect(clerk.writes().filter((r) => r.path === '/v1/instance')).toEqual([])
    })
    it('no origins requested: nothing written, the present ones are extra', async () => {
      const { clerk, w } = setup(settled({ allowedOrigins: ['https://x.example'] }))
      await run(w, clerk, onlyClerk())
      expect(clerk.writes()).toEqual([])
    })
  })

  describe('C6, C7, C9 (D16, D30, D31): one GET, at most one PATCH with only the differing fields', () => {
    it('equal (default_scopes in another order): no PATCH', async () => {
      const { clerk, w } = setup(settled())
      await run(w, clerk, onlyClerk())
      expect(settingsWrites(clerk)).toEqual([])
      expect(clerk.requests.filter((r) => r.path.startsWith('/v1/instance/oauth_application_settings')).map((r) => r.method)).toEqual(['GET'])
    })
    it('one differing field: one PATCH with exactly that field', async () => {
      const { clerk, w } = setup(settled({ settings: { oauth_jwt_access_tokens: false, dynamic_oauth_client_registration: true, default_scopes: readScopes } }))
      await run(w, clerk, onlyClerk())
      expect(settingsWrites(clerk).map((r) => r.body)).toEqual([{ oauth_jwt_access_tokens: true }])
    })
    it('all differing: one PATCH with the three fields, the agent-grantable read scopes as defaults, and no ceiling', async () => {
      const { clerk, w } = setup(settled({ settings: { dynamic_oauth_client_registration: false, default_scopes: [], oauth_jwt_access_tokens: false } }))
      const o = await run(w, clerk, onlyClerk())
      const writes = settingsWrites(clerk)
      expect(writes).toHaveLength(1)
      const body = writes[0]!.body as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(['default_scopes', 'dynamic_oauth_client_registration', 'oauth_jwt_access_tokens'])
      expect(sameSet(body.default_scopes as string[], readScopes)).toBe(true)
      expect(readScopes.length).toBeGreaterThan(0)
      expect(body).not.toHaveProperty('dynamic_client_allowed_scopes')
      expect(text(o)).toMatch(/^C6\s/m)
      expect(text(o)).toMatch(/^C7\s/m)
      expect(text(o)).toMatch(/^C9\s/m)
    })
    it('--no-dcr does not turn registration on', async () => {
      const { clerk, w } = setup(settled({ settings: { dynamic_oauth_client_registration: false } }))
      await run(w, clerk, onlyClerk(['--no-dcr']))
      expect(settingsWrites(clerk).flatMap((r) => Object.keys(r.body as object))).not.toContain('dynamic_oauth_client_registration')
    })
  })

  describe('C8 the Vibase CLI application (D15, D31)', () => {
    it('none: created with the full ceiling plus offline_access, public, device grant, consent screen; the client secret is never shown', async () => {
      const { clerk, w } = setup(settled({ apps: [] }))
      const o = await run(w, clerk, onlyClerk())
      const posts = appWrites(clerk).filter((r) => r.method === 'POST')
      expect(posts).toHaveLength(1)
      const body = posts[0]!.body as Record<string, unknown>
      expect(body).toMatchObject({ name: 'Vibase CLI', public: true, device_authorization_grant_enabled: true, consent_screen_enabled: true })
      expect(sameSet((body.scopes as string).split(' '), cliScopes)).toBe(true)
      expect(text(o)).toMatch(/^C8\s+create/m)
      expect(w.logs.join('\n')).not.toContain('client-secret-canary')
    })
    it('one by name: a PATCH with only the fields that differ', async () => {
      const { clerk, w } = setup(settled({ apps: [{ scopes: cliScopes.join(' '), device_authorization_grant_enabled: false }] }))
      await run(w, clerk, onlyClerk())
      expect(appWrites(clerk).map((r) => [r.method, r.path, r.body])).toEqual([['PATCH', '/v1/oauth_applications/oauthapp_1', { device_authorization_grant_enabled: true }]])
    })
    it('one by name, scopes short of the ceiling: PATCH carries the scopes', async () => {
      const { clerk, w } = setup(settled({ apps: [{ scopes: 'tasks:read' }] }))
      await run(w, clerk, onlyClerk())
      const [patch] = appWrites(clerk)
      expect(sameSet(((patch!.body as { scopes: string }).scopes).split(' '), cliScopes)).toBe(true)
      expect(Object.keys(patch!.body as object)).toEqual(['scopes'])
    })
    it('already as desired: no write, row ok', async () => {
      const { clerk, w } = setup(settled())
      const o = await run(w, clerk, onlyClerk())
      expect(appWrites(clerk)).toEqual([])
      expect(text(o)).toMatch(/^C8\s+ok/m)
    })
    it('two by name and no configured id: a fail listing both ids, nothing written to apps, every other row still evaluated', async () => {
      const { clerk, w } = setup(settled({ apps: [{ scopes: '' }, { scopes: '' }] }))
      const o = await run(w, clerk, onlyClerk())
      expect(states(o)).toEqual(['clerk:fail'])
      expect(text(o)).toMatch(/^C8\s+fail.*oauthapp_1.*oauthapp_2|^C8\s+fail[\s\S]*client_1[\s\S]*client_2/m)
      expect(appWrites(clerk)).toEqual([])
      for (const row of ['C1', 'C2', 'C3', 'C4', 'C6', 'C7', 'C9', 'C10']) expect(text(o), row).toMatch(new RegExp(`^${row}\\s`, 'm'))
    })
    it('the configured AUTH_CLI_CLIENT_ID finds the application by id, whatever its name, even with a second one by name', async () => {
      const cfg = parse(realConfig) as unknown
      expect(cfg).toBeTruthy()
      const configText = realConfig.replace(/\n\s*"env": \{/, (m) => m) // the env block is added below
      const { reconcileEnvBlock } = await import('./config-editor.js')
      const withBlock = reconcileEnvBlock(configText, {
        env: 'acme', workerName: 'vault-acme', d1Name: 'vault-acme', d1Id: '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b', r2Name: 'vault-acme-bodies', apiHost: 'api.acme.vibase.ai', corsOrigins: '',
        authVars: { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: PK_TEST, CLERK_AUTHORIZED_PARTIES: 'https://api.acme.vibase.ai', AUTH_CLI_CLIENT_ID: 'client_2' },
      }).text
      const { clerk, w } = setup(settled({ apps: [{ name: 'Vibase CLI', scopes: '' }, { name: 'Renamed', scopes: cliScopes.join(' ') }] }), { configText: withBlock })
      const o = await run(w, clerk, onlyClerk())
      expect(states(o)).toEqual(['clerk:ok'])
      expect(appWrites(clerk)).toEqual([])
    })
    it('a refused device grant is a fail naming the prerequisite', async () => {
      const { clerk, w } = setup(settled({ apps: [], deviceGrantRefused: true }))
      const o = await run(w, clerk, onlyClerk())
      expect(states(o)).toEqual(['clerk:fail'])
      expect(text(o)).toMatch(/^C8\s+fail[\s\S]*(device|verification page)/im)
    })
  })

  describe('C5 the scope catalog (D29)', () => {
    it('Clerk refusing unknown custom keys on C8 makes C5 a fail with the checklist: every declared scope with its description', async () => {
      const { clerk, w } = setup(settled({ apps: [], catalog: [] }))
      const o = await run(w, clerk, onlyClerk())
      expect(states(o)).toEqual(['clerk:fail'])
      expect(text(o)).toMatch(/^C5\s+fail/m)
      for (const s of declared) expect(text(o)).toContain(s)
      expect(text(o)).toContain('Dashboard')
    })
    it('accepted: ok', async () => {
      const { clerk, w } = setup(settled({ apps: [] }))
      expect(text(await run(w, clerk, onlyClerk()))).toMatch(/^C5\s+ok/m)
    })
    it('a dry run reads scopes_supported: all present is ok; missing ones are unverified, never fail', async () => {
      const present = setup(settled({ scopesSupported: declared.map(toProviderScope) }))
      expect(text(await run(present.w, present.clerk, onlyClerk(['--dry-run']), {}))).toMatch(/^C5\s+ok/m)
      const missing = setup(settled({ scopesSupported: ['tasks:read'] }))
      const o = await run(missing.w, missing.clerk, onlyClerk(['--dry-run']), {})
      expect(text(o)).toMatch(/^C5\s+\S+\s.*unverified/im)
      expect(text(o)).not.toMatch(/^C5\s+fail/m)
      const unreadable = setup(settled({ scopesSupported: null }))
      expect(text(await run(unreadable.w, unreadable.clerk, onlyClerk(['--dry-run']), {}))).toMatch(/^C5\s+\S+\s.*unverified/im)
    })
  })

  describe('C10 the first owner (D17, D38)', () => {
    const noUser = (c: ClerkOptions = {}) => settled({ users: [], ...c })
    it('no user, no invitation: an invitation with vibase_role owner and notify true; its link is never shown', async () => {
      const { clerk, w } = setup(noUser())
      const o = await run(w, clerk, onlyClerk())
      const posts = clerk.writes().filter((r) => r.path === '/v1/invitations')
      expect(posts.map((r) => r.body)).toEqual([{ email_address: OWNER_EMAIL, public_metadata: { vibase_role: 'owner' }, notify: true }])
      expect(text(o)).toMatch(/^C10\s+create/m)
      expect(w.surface()).not.toContain('INVITATION-URL-CANARY')
      expect(text(o)).not.toContain('INVITATION-URL-CANARY')
    })
    it('a pending invitation (address matched case-insensitively): no write', async () => {
      const { clerk, w } = setup(noUser({ invitations: [{ object: 'invitation', id: 'inv_1', email_address: OWNER_EMAIL.toLowerCase(), public_metadata: { vibase_role: 'owner' }, status: 'pending', url: 'u' }] }))
      const o = await run(w, clerk, onlyClerk())
      expect(clerk.writes()).toEqual([])
      expect(text(o)).toMatch(/^C10\s+ok/m)
    })
    it('a pending invitation for a longer address that merely contains it is not a match', async () => {
      const { clerk, w } = setup(noUser({ invitations: [{ object: 'invitation', id: 'inv_9', email_address: `x${OWNER_EMAIL}`, public_metadata: {}, status: 'pending', url: 'u' }] }))
      await run(w, clerk, onlyClerk())
      expect(clerk.writes().filter((r) => r.path === '/v1/invitations')).toHaveLength(1)
    })
    it('a user without a role: owner is set on its public metadata', async () => {
      const { clerk, w } = setup(settled({ users: [{ id: 'user_7', object: 'user', email_addresses: [{ email_address: OWNER_EMAIL }], public_metadata: { other: 1 } }] }))
      const o = await run(w, clerk, onlyClerk())
      expect(clerk.writes().map((r) => [r.method, r.path, r.body])).toEqual([['PATCH', '/v1/users/user_7/metadata', { public_metadata: { vibase_role: 'owner' } }]])
      expect(text(o)).toMatch(/^C10\s+update/m)
    })
    it('a user who already is owner: ok, no write', async () => {
      const { clerk, w } = setup(settled())
      await run(w, clerk, onlyClerk())
      expect(clerk.writes()).toEqual([])
    })
    it('a user with another role: a fail, no write', async () => {
      const { clerk, w } = setup(settled({ users: [{ id: 'user_8', object: 'user', email_addresses: [{ email_address: OWNER_EMAIL }], public_metadata: { vibase_role: 'member' } }] }))
      const o = await run(w, clerk, onlyClerk())
      expect(states(o)).toEqual(['clerk:fail'])
      expect(text(o)).toMatch(/^C10\s+fail/m)
      expect(clerk.writes()).toEqual([])
    })
  })
})

describe('7. a Clerk fail stops before config:write, with every row evaluated and the checklist printed', () => {
  it('config and later steps are untouched; the D1 and R2 from config:resources stay', async () => {
    const { clerk, w } = setup(settled({ signUpMode: 'public', apps: [], catalog: [] }))
    const o = await run(w, clerk, BASE)
    expect(o.exitCode).toBe(1)
    expect(states(o)).toEqual(['preflight:ok', 'config:resources:create', 'clerk:fail'])
    expect(w.state.configText).toBe(realConfig)
    expect(w.state.configWrites).toBe(0)
    expect(w.state.d1s.map((d) => d.name)).toEqual(['vault-acme'])
    for (const row of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10']) expect(text(o), row).toMatch(new RegExp(`^${row}\\s`, 'm'))
    expect(text(o)).toMatch(/^C1\s+fail/m)
    expect(text(o)).toMatch(/^C5\s+fail/m)
    expect(w.logs.join('\n')).toMatch(/setup: failed/)
    expect(w.argv.some((c) => c.includes('apply') || c.includes('deploy'))).toBe(false)
  })
})

describe('full flow, 8. idempotence', () => {
  const FLOW = [...BASE, '--web-origin', 'https://app.example.com']
  it('run 1 stops after config:write, run 2 finishes, run 3 changes nothing anywhere', async () => {
    const { clerk, w } = setup()
    const first = await run(w, clerk, FLOW)
    expect(states(first)).toEqual(['preflight:ok', 'config:resources:create', 'clerk:create', 'config:write:update'])
    expect(first.stoppedAfterConfigWrite).toBe(true)
    const cfg = (parse(w.state.configText) as { env: Record<string, { vars: Record<string, string> }> }).env.acme!.vars
    expect(cfg).toEqual({ AUTH_PROVIDER: 'clerk', CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: PK_TEST, CLERK_AUTHORIZED_PARTIES: 'https://api.acme.vibase.ai,https://app.example.com', AUTH_CLI_CLIENT_ID: clerk.state.apps[0]!.client_id, CORS_ALLOWED_ORIGINS: 'https://app.example.com' })
    expect(clerk.state.allowedOrigins).toEqual(['https://app.example.com'])

    const second = await run(w, clerk, FLOW)
    expect(states(second)).toEqual(['preflight:ok', 'config:resources:ok', 'clerk:ok', 'config:write:ok', 'migrate:update', 'bootstrap:create', 'deploy:update', 'secrets:create', 'verify:ok'])
    expect(await readDeployment(db.d1)).toMatchObject({ authProvider: 'clerk', authOrgId: ISSUER })
    expect(Object.keys(w.state.secrets).sort()).toEqual(['CLERK_JWT_KEY', 'CLERK_SECRET_KEY'])

    const clerkWrites = clerk.writes().length
    const before = w.argv.length
    const configBefore = w.state.configText
    const third = await run(w, clerk, FLOW)
    expect(states(third)).toEqual(['preflight:ok', 'config:resources:ok', 'clerk:ok', 'config:write:ok', 'migrate:ok', 'bootstrap:ok', 'deploy:ok', 'secrets:ok', 'verify:ok'])
    expect(clerk.writes().length).toBe(clerkWrites)
    expect(w.argv.slice(before).filter(isWriteCommand)).toEqual([])
    expect(w.state.configText).toBe(configBefore)
  })
  it('--dry-run on an empty state issues no non-GET Clerk request and no write subprocess, and writes no file', async () => {
    const { clerk, w } = setup()
    const o = await run(w, clerk, [...FLOW, '--dry-run'], {})
    expect(o.exitCode).toBe(0)
    expect(clerk.writes()).toEqual([])
    expect(w.writes()).toEqual([])
    expect(w.state.configWrites).toBe(0)
    expect(w.state.configText).toBe(realConfig)
    expect(states(o)[0]).toBe('preflight:ok')
    expect(states(o)).toContain('clerk:create')
    expect(states(o)).toContain('config:write:update')
  })
  it('--auth none makes no Clerk request and asks for no env file', async () => {
    const { clerk, w } = setup()
    await runSetup(['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai'], CONFIRM, w.deps)
    expect(clerk.requests).toEqual([])
    expect(w.probes).toEqual([])
  })
})

describe('10. no secret in any output', () => {
  it('the secret key, the PEM, the invitation link and the client secret appear in no argv, log, diff, file or URL; the secrets travel only on secret bulk stdin', async () => {
    const { clerk, w } = setup()
    const args = [...BASE, '--web-origin', 'https://app.example.com', '--operator-agent', 'operator', '--key-env', 'ACME_KEY', '--rotate-secrets']
    await run(w, clerk, args)
    await run(w, clerk, args)
    await run(w, clerk, args)
    const pem = createPublicKey({ key: jwkFor('ins_kid_1') as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()
    const pemBody = pem.replace(/-----[A-Z ]+-----|\s/g, '')
    const key = /^ACME_KEY=(.+)$/m.exec(w.state.envText)?.[1]
    expect(key).toBeTruthy()
    const everything = [w.surface(), w.fetched.join('\n'), w.state.configText, ...w.logs].join('\n')
    for (const secret of [SK_TEST, pemBody, 'BEGIN PUBLIC KEY', 'INVITATION-URL-CANARY', 'client-secret-canary', key!]) expect(everything, secret.slice(0, 12)).not.toContain(secret)
    expect(w.secretInputs.length).toBeGreaterThan(0)
    for (const input of w.secretInputs) {
      const body = JSON.parse(input) as Record<string, string>
      expect(Object.keys(body).every((k) => k === 'CLERK_SECRET_KEY' || k === 'CLERK_JWT_KEY')).toBe(true)
    }
    expect(w.secretInputs[0]).toContain(SK_TEST)
    expect(JSON.parse(w.secretInputs[0]!).CLERK_JWT_KEY).toContain('BEGIN PUBLIC KEY')
    expect(w.argv.filter((c) => c.includes('bulk')).every((c) => !c.join(' ').includes(SK_TEST))).toBe(true)
  })
})

describe('11. the secrets step (D12)', () => {
  const secrets = [...BASE, '--only', 'secrets']
  it('missing ones are put: exactly the two names, on stdin; ok afterwards with no further put', async () => {
    const { clerk, w } = setup({}, { configText: await acmeConfig() })
    const o = await run(w, clerk, secrets)
    expect(states(o)).toEqual(['secrets:create'])
    const bulks = w.argv.filter((c) => c.includes('bulk'))
    expect(bulks).toHaveLength(1)
    expect(bulks[0]).toEqual(expect.arrayContaining(['wrangler', 'secret', 'bulk', '--env', 'acme']))
    expect(Object.keys(JSON.parse(w.secretInputs[0]!)).sort()).toEqual(['CLERK_JWT_KEY', 'CLERK_SECRET_KEY'])
    expect(states(await run(w, clerk, secrets))).toEqual(['secrets:ok'])
    expect(w.argv.filter((c) => c.includes('bulk'))).toHaveLength(1)
  })
  it('present secrets are left alone: no bulk, and the JWKS is not even read', async () => {
    const { clerk, w } = setup({}, { secrets: ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY'], configText: await acmeConfig() })
    expect(states(await run(w, clerk, secrets))).toEqual(['secrets:ok'])
    expect(w.argv.some((c) => c.includes('bulk'))).toBe(false)
    expect(w.secretInputs).toEqual([])
  })
  it('one present: only the missing one is sent', async () => {
    const { clerk, w } = setup({}, { secrets: ['CLERK_SECRET_KEY'], configText: await acmeConfig() })
    await run(w, clerk, secrets)
    expect(Object.keys(JSON.parse(w.secretInputs[0]!))).toEqual(['CLERK_JWT_KEY'])
  })
  it('--rotate-secrets re-puts both', async () => {
    const { clerk, w } = setup({}, { secrets: ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY'], configText: await acmeConfig() })
    const o = await run(w, clerk, [...secrets, '--rotate-secrets'])
    expect(states(o)).toEqual(['secrets:update'])
    expect(Object.keys(JSON.parse(w.secretInputs[0]!)).sort()).toEqual(['CLERK_JWT_KEY', 'CLERK_SECRET_KEY'])
  })
  it('a dry run lists what it would put and issues no put', async () => {
    const { clerk, w } = setup({}, { configText: await acmeConfig() })
    const o = await run(w, clerk, [...secrets, '--dry-run'], {})
    expect(states(o)).toEqual(['secrets:create'])
    expect(w.argv.some((c) => c.includes('bulk'))).toBe(false)
    expect(w.writes()).toEqual([])
  })
  it('the derived PEM is the JWKS key', async () => {
    const { clerk, w } = setup({}, { configText: await acmeConfig() })
    await run(w, clerk, secrets)
    const sent = JSON.parse(w.secretInputs[0]!).CLERK_JWT_KEY as string
    expect(createPublicKey(sent).export({ format: 'jwk' })).toMatchObject({ n: jwkFor('ins_kid_1').n })
  })
})

describe('12. verify (D21) and 13. the repair hint (D39)', () => {
  const FLOW = [...BASE]
  async function deployed(c: ClerkOptions = {}, o: Partial<WorldOptions> = {}) {
    const ctx = setup(c, o)
    await run(ctx.w, ctx.clerk, FLOW)
    await run(ctx.w, ctx.clerk, FLOW)
    return ctx
  }
  it('issuer and cli_client_id equal to what setup configured: ok, with the next steps', async () => {
    const { clerk, w } = await deployed()
    const o = await run(w, clerk, [...FLOW, '--only', 'verify'])
    expect(states(o)).toEqual(['verify:ok'])
    const t = text(o, 'verify')
    expect(t).toContain('GET /meta/v1/me')
    expect(t).toContain('role: owner')
    expect(t).toMatch(/vibase login --server https:\/\/api\.acme\.vibase\.ai/)
    expect(t).toMatch(/invitation/i)
    expect(t).toMatch(/C3/)
  })
  it('an issuer mismatch on /.well-known/vibase is a fail', async () => {
    const { clerk, w, opts } = await deployed()
    opts.vibase = { issuer: 'https://someone-else.clerk.accounts.dev', cli_client_id: clerk.state.apps[0]!.client_id }
    const o = await run(w, clerk, [...FLOW, '--only', 'verify'])
    expect(states(o)).toEqual(['verify:fail'])
    expect(text(o, 'verify')).toMatch(/issuer/)
  })
  it('a cli_client_id mismatch is a fail', async () => {
    const { clerk, w, opts } = await deployed()
    opts.vibase = { issuer: ISSUER, cli_client_id: 'client_other' }
    const o = await run(w, clerk, [...FLOW, '--only', 'verify'])
    expect(states(o)).toEqual(['verify:fail'])
    expect(text(o, 'verify')).toMatch(/cli_client_id/)
  })
  it('no /.well-known/vibase answer is a fail', async () => {
    const { clerk, w, opts } = await deployed()
    opts.vibase = 'absent'
    expect(states(await run(w, clerk, [...FLOW, '--only', 'verify']))).toEqual(['verify:fail'])
  })

  it('13. clerk: marker and organisation present prints no bootstrap command and says how agents are created', async () => {
    const { clerk, w } = await deployed()
    const t = text(await run(w, clerk, [...FLOW, '--only', 'verify']), 'verify')
    expect(t).not.toMatch(/bootstrap -- /)
    expect(t).toMatch(/agents\.create/)
    expect(t).toMatch(/api_keys\.create/)
  })
  it('13. clerk: a marker with no organisation prints the bootstrap command (with --issuer)', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, BASE)
    w.state.applied = [...EXPECTED_MIGRATIONS]
    w.state.deployedSha = SHA
    const link = { organizationId: '0192f0a0-0000-7000-8000-000000000001', authProvider: 'clerk', authOrgId: ISSUER }
    await execute(d1Binding(db.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
    const t = text(await run(w, clerk, [...BASE, '--only', 'verify']), 'verify')
    expect(t).toContain('bootstrap -- --remote --env acme')
    expect(t).toContain(`--issuer ${ISSUER}`)
  })
  it('13. none: marker and organisation present prints no bootstrap command', async () => {
    const w = makeWorld({ d1: db.d1, d1s: [{ uuid: '13f7fb64-d909-44e7-9ce7-cc3c753bb3bc', name: 'vault-smoked1' }], r2s: ['vault-smoked1-bodies'], applied: [...EXPECTED_MIGRATIONS], deployedSha: SHA })
    await bootstrapD1(db.d1, { organizationName: 'smoked1', email: 'o@example.com', agentName: 'a', authProvider: 'none', authOrgId: 'smoked1' })
    const o = await runSetup(['--env', 'smoked1', '--auth', 'none', '--api-host', 'api.smoked1.vibase.ai', '--only', 'verify'], CONFIRM, w.deps)
    const t = text(o, 'verify')
    expect(t).not.toMatch(/bootstrap -- /)
    expect(t).toMatch(/agents\.create/)
  })
})

describe('bootstrap with the Clerk marker (D18, D38)', () => {
  it('the marker is clerk:<issuer>, no human is created, and with the operator flags the key goes to .env only', async () => {
    const { clerk, w } = setup()
    const args = [...BASE, '--operator-agent', 'operator', '--key-env', 'ACME_KEY']
    await run(w, clerk, args)
    const second = await run(w, clerk, args)
    expect(states(second)).toContain('bootstrap:create')
    expect(await readDeployment(db.d1)).toMatchObject({ authProvider: 'clerk', authOrgId: ISSUER })
    expect(w.state.envText).toMatch(/^ACME_KEY=.{17,}$/m)
    const users = await db.d1.prepare('select count(*) as n from users').first()
    expect((users as { n: number } | null)?.n).toBe(0)
  })
  it('a marker for another issuer is a fail', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, BASE)
    w.state.applied = [...EXPECTED_MIGRATIONS]
    const link = { organizationId: '0192f0a0-0000-7000-8000-000000000001', authProvider: 'clerk', authOrgId: 'https://other.clerk.accounts.dev' }
    await execute(d1Binding(db.d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
    const o = await run(w, clerk, [...BASE, '--only', 'bootstrap'])
    expect(states(o)).toEqual(['bootstrap:fail'])
  })
})

// [[UI30]] D7: the connect page's own origin is an authorized party, and the publishable key is a public var.
describe('D7 the connect page origin and the publishable key', () => {
  const vars = (w: World, env = 'acme') => (parse(w.state.configText) as { env: Record<string, { vars: Record<string, string> }> }).env[env]!.vars
  const API = 'https://api.acme.vibase.ai'

  it('--auth clerk writes CLERK_PUBLISHABLE_KEY and the api origin as the only authorized party; CORS and Clerk allowed_origins stay empty', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, BASE)
    expect(vars(w)).toMatchObject({ CLERK_PUBLISHABLE_KEY: PK_TEST, CLERK_AUTHORIZED_PARTIES: API, CORS_ALLOWED_ORIGINS: '' })
    expect(clerk.state.allowedOrigins).toEqual([])
    expect(clerk.writes().filter((r) => r.path === '/v1/instance' && (r.body as { allowed_origins?: unknown })?.allowed_origins !== undefined)).toEqual([])
  })

  it('beside --web-origin and --extra-origin: the api origin first, deduplicated; CORS and allowed_origins carry only what was passed', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, [...BASE, '--web-origin', 'https://app.example.com', '--extra-origin', API, '--extra-origin', 'https://app.example.com'])
    expect(vars(w).CLERK_AUTHORIZED_PARTIES).toBe(`${API},https://app.example.com`)
    expect(vars(w).CORS_ALLOWED_ORIGINS).toBe(`https://app.example.com,${API},https://app.example.com`)
    expect(clerk.state.allowedOrigins).toEqual(expect.arrayContaining(['https://app.example.com']))
    expect(clerk.state.allowedOrigins).not.toContain(API)
  })

  it('a second run writes nothing', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, BASE)
    await run(w, clerk, BASE)
    const before = w.state.configText
    const writes = w.state.configWrites
    const third = await run(w, clerk, BASE)
    expect(states(third)).toContain('config:write:ok')
    expect(w.state.configText).toBe(before)
    expect(w.state.configWrites).toBe(writes)
  })

  it('a dry run over a block with an empty CLERK_AUTHORIZED_PARTIES and no key (as hq today) plans exactly those two vars', async () => {
    const hqLike = (await acmeConfig()).replace(`"CLERK_PUBLISHABLE_KEY": "${PK_TEST}",`, '').replace('"CLERK_AUTHORIZED_PARTIES": "https://api.acme.vibase.ai"', '"CLERK_AUTHORIZED_PARTIES": ""')
    expect(hqLike).not.toContain('CLERK_PUBLISHABLE_KEY')
    const { clerk, w } = setup(settled(), { configText: hqLike })
    const o = await run(w, clerk, [...BASE, '--dry-run'], {})
    const write = states(o).find((x) => x.startsWith('config:write'))
    expect(write).toBe('config:write:update')
    expect(text(o, 'config:write')).toMatch(/vars\.CLERK_PUBLISHABLE_KEY/)
    expect(text(o, 'config:write')).toMatch(/vars\.CLERK_AUTHORIZED_PARTIES/)
    expect(text(o, 'config:write')).not.toMatch(/differs/)
    expect(w.state.configText).toBe(hqLike)
  })

  it('a hand-added party survives (union, never removed)', async () => {
    const withExtra = (await acmeConfig()).replace('"CLERK_AUTHORIZED_PARTIES": "https://api.acme.vibase.ai"', '"CLERK_AUTHORIZED_PARTIES": "https://hand.example,https://api.acme.vibase.ai"')
    const { clerk, w } = setup(settled(), { configText: withExtra })
    const o = await run(w, clerk, [...BASE, '--dry-run'], {})
    expect(states(o).find((x) => x.startsWith('config:write'))).toBe('config:write:ok')
  })

  it('a different publishable key already in the config is a mismatch naming the variable; the file is untouched', async () => {
    const other = (await acmeConfig()).replace(PK_TEST, ['pk', 'test', btoa('other.clerk.accounts.dev$')].join('_'))
    const { clerk, w } = setup(settled(), { configText: other })
    const o = await run(w, clerk, [...BASE, '--dry-run'], {})
    expect(states(o).find((x) => x.startsWith('config:write'))).toBe('config:write:fail')
    expect(text(o, 'config:write')).toContain('env.acme.vars.CLERK_PUBLISHABLE_KEY')
    expect(w.state.configText).toBe(other)
  })

  it('--auth none writes neither variable', async () => {
    const { clerk, w } = setup()
    await runSetup(['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai'], CONFIRM, w.deps)
    expect(clerk.requests).toEqual([])
    const v = vars(w)
    expect(v).toEqual({ AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' })
  })

  it('the secret key is in neither the written config nor the plan', async () => {
    const { clerk, w } = setup()
    await run(w, clerk, BASE)
    expect(w.state.configText).not.toContain(SK_TEST)
    const o = await run(w, clerk, [...BASE, '--dry-run'], {})
    expect(text(o, 'config:write')).not.toContain(SK_TEST)
  })
})
