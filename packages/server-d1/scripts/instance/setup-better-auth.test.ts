// OPS249 cycle 1 on `vibase-server setup`: the provider rule (D1), the Better Auth vars (D2), `AUTH_SECRET` (D3), the Google pair (D4), the bootstrap step (D6) and re-runs that never
// re-issue the owner link (D7). The same obligations for `setup:remote` are in setup/better-auth.test.ts. Everything runs against the instance kit's fake wrangler and fetch, a real
// secrets file and settings file on disk, and two real local D1s (CRM and control) behind the bootstrap step.
import { readFileSync, statSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openControlDb, readControlMarker } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { bootstrapD1 } from '../../src/bootstrap-d1.js'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { makeClerk } from '../setup/test/clerk-world.js'
import { memoryControl } from '../setup/test/world.js'
import {
  ALL_MIGRATIONS,
  API_HOST,
  CLERK_SECRETS_TEXT,
  readMarker,
  setupWorld,
  type SetupWorld,
  type SetupWorldOptions,
} from './setup-kit.js'
import { runSetup } from './setup.js'
import { CONTROL_ALL, CONTROL_UUID, SECRETS_TEXT, UUID, cleanup, controlSettings } from './test-kit.js'

const BASE = `https://${API_HOST}`
const OWNER = 'owner@example.com'
const ARGS = ['--env', 'demo', '--api-host', API_HOST, '--owner-email', OWNER]
const SECRET_43 = 'A'.repeat(20) + 'b'.repeat(20) + '-_9'

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
const rowsOf = async (d1: WorkerPair['d1'], q: string) =>
  ((await d1.prepare(q).all()).results ?? []) as Record<string, any>[]
const row = (s: SetupWorld, name: string) => s.rows().find((r) => r.step === name)!
const header = (s: SetupWorld) => /, auth (\S+),/.exec(s.w.out.find((l) => l.startsWith('setup: env')) ?? '')?.[1]
const file = (s: SetupWorld) => readFileSync(s.w.secretsPath, 'utf8')
const surface = (s: SetupWorld) =>
  [
    s.w.all(),
    s.settings() ?? '',
    ...s.w.wrangler.map((c) => c.args.join(' ')),
    ...s.w.wrangler.flatMap((c) => (c.configText ? [c.configText] : [])),
    ...s.w.fetchUrls,
  ].join('\n')
const bulks = (s: SetupWorld) =>
  s.w.wrangler
    .filter((c) => c.args.includes('secret') && c.args.includes('bulk'))
    .map((c) => JSON.parse(c.input!) as Record<string, string>)
const urlLines = (s: SetupWorld) => s.w.out.filter((l) => l.includes('/invite#token='))
const tokenOf = (s: SetupWorld) => /\/invite#token=([A-Za-z0-9_-]+)/.exec(s.w.out.join('\n'))?.[1]
const before = (s: SetupWorld) => {
  s.w.out.length = 0
  s.w.err.length = 0
  s.w.wrangler.length = 0
}

const BA_VARS = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, CORS_ALLOWED_ORIGINS: '' }
/** An instance that is recorded, created, migrated, deployed and (when `marker`) bootstrapped: the state the secrets and re-run groups start from. */
const recorded = (vars: Record<string, string> = BA_VARS) => ({
  settings: controlSettings({ vars }),
  secretsText: SECRETS_TEXT,
  sim: {
    d1s: [
      { uuid: UUID, name: 'vault-demo' },
      { uuid: CONTROL_UUID, name: 'ctl-recorded-name' },
    ],
    r2s: ['vault-demo-bodies'],
    applied: [...ALL_MIGRATIONS],
    controlApplied: [...CONTROL_ALL],
    deployed: { version: 'v', commit: 'c' },
  },
})
const ONLY_SECRETS = [...ARGS, '--only', 'secrets']

describe('1. the provider rule (D1): matrix over a new instance and a recorded one', () => {
  const NEW: [string, string[], string][] = [
    ['no flag', [], 'better-auth'],
    ['--auth clerk', ['--auth', 'clerk'], 'clerk'],
    ['--auth none', ['--auth', 'none'], 'none'],
  ]
  it.each(NEW)('a new instance, %s: runs as %s', async (_n, flag, expected) => {
    const s = world({ secretsText: CLERK_SECRETS_TEXT, sim: { clerk: makeClerk() } })
    await run(s, [...ARGS, ...flag, '--dry-run'])
    expect(header(s), s.w.all()).toBe(expected)
  })

  const RECORDS: [string, Record<string, string>, string][] = [
    ['better-auth', BA_VARS, 'better-auth'],
    ['clerk', { AUTH_PROVIDER: 'clerk' }, 'clerk'],
    ['none (AUTH_PROVIDER empty)', { AUTH_PROVIDER: '' }, 'none'],
    ['none (no AUTH_PROVIDER at all)', { CORS_ALLOWED_ORIGINS: '' }, 'none'],
  ]
  const ALL = ['better-auth', 'clerk', 'none']
  describe.each(RECORDS)('recorded %s', (_n, vars, rec) => {
    const mk = () =>
      world({ ...recorded(vars), secretsText: CLERK_SECRETS_TEXT, sim: { ...recorded(vars).sim, clerk: makeClerk() } })
    it('no flag: the recorded provider', async () => {
      const s = mk()
      await run(s, [...ARGS, '--dry-run'])
      expect(header(s), s.w.all()).toBe(rec)
    })
    it('the same flag: accepted', async () => {
      const s = mk()
      await run(s, [...ARGS, '--auth', rec, '--dry-run'])
      expect(header(s), s.w.all()).toBe(rec)
    })
    it.each(ALL.filter((p) => p !== rec))(
      '--auth %s differs: refused (exit 2) before any wrangler or Cloudflare call, naming the record and OPS250',
      async (flag) => {
        const s = mk()
        expect(await run(s, [...ARGS, '--auth', flag, '--dry-run'])).toBe(2)
        expect(s.w.wrangler).toEqual([])
        expect(s.w.fetchUrls).toEqual([])
        const said = s.w.err.join('\n')
        expect(said).toContain(`--auth ${flag}`)
        expect(said).toContain(rec)
        expect(said).toContain('OPS250')
      },
    )
  })
})

describe('2. vars and refusals on better-auth (D2)', () => {
  it('the settings file holds AUTH_PROVIDER and PUBLIC_BASE_URL and no Clerk variable, and is itself the record of the next run', async () => {
    const s = world()
    expect(await run(s), s.w.all()).toBe(0)
    const written = JSON.parse(s.settings()!)
    expect(written.vars).toEqual({ AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, CORS_ALLOWED_ORIGINS: '' })
    expect(JSON.stringify(written)).not.toMatch(/CLERK|AUTH_CLI_CLIENT_ID|AUTH_ROLE_CLAIM/)
    // the generated wrangler config carries the same two vars
    const configs = s.w.wrangler.flatMap((c) => (c.configText ? [JSON.parse(c.configText) as Record<string, any>] : []))
    expect(configs.length).toBeGreaterThan(0)
    for (const c of configs)
      if (c.vars) expect(c.vars).toMatchObject({ AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE })
    before(s)
    expect(await run(s)).toBe(0)
    expect(row(s, 'config:write').status).toBe('ok')
  })

  it.each([['--clerk-publishable-key', 'pk_test_x'], ['--clerk-production'], ['--no-dcr']])(
    '%s is refused with better-auth (exit 2), before any step',
    async (...flag) => {
      const s = world()
      expect(await run(s, [...ARGS, ...flag])).toBe(2)
      expect(s.w.err.join('\n')).toContain('--auth clerk')
      expect(s.w.wrangler).toEqual([])
      expect(s.w.fetchUrls).toEqual([])
    },
  )

  const gmail = (base?: string) =>
    `${SECRETS_TEXT}GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=gsecret-0123456789\nOAUTH_STATE_SECRET=state-0123456789\nCREDENTIALS_KEY=${Buffer.alloc(32, 7).toString('base64')}\n${base ? `PUBLIC_BASE_URL=${base}\n` : ''}`
  it('a Gmail-group PUBLIC_BASE_URL that differs from the derived one is refused (exit 2) before any step', async () => {
    const s = world({ secretsText: gmail('https://other.example.com') })
    expect(await run(s)).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/PUBLIC_BASE_URL/)
    expect(s.w.wrangler).toEqual([])
  })
  it('the same value as the derived one is accepted', async () => {
    const s = world({ secretsText: gmail(BASE) })
    expect(await run(s, [...ARGS, '--dry-run'])).toBe(0)
  })
})

describe('3. AUTH_SECRET (D3), four states', () => {
  it('(a) neither file nor Worker: generated (43 base64url characters), written to the secrets file BEFORE the put, put on stdin only', async () => {
    const s = world(recorded())
    expect(await run(s, ONLY_SECRETS), s.w.all()).toBe(0)
    const put = bulks(s)
    expect(put).toHaveLength(1)
    const value = put[0]!.AUTH_SECRET!
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.sim.bulkFile[0], 'the file must already hold the value when the put runs').toContain(
      `AUTH_SECRET=${value}`,
    )
    expect(file(s)).toContain(`AUTH_SECRET=${value}\n`)
    expect(statSync(s.w.secretsPath).mode & 0o777).toBe(0o600)
    expect(row(s, 'secrets').status).toBe('create')
    expect(surface(s)).not.toContain(value)
  })

  it('(a) a put that fails leaves the value in the file; the next run is state (b) and puts the same value', async () => {
    const s = world(recorded())
    s.sim.failBulk = true
    expect(await run(s, ONLY_SECRETS)).toBe(3)
    expect(row(s, 'secrets').status).toBe('fail')
    const stored = /^AUTH_SECRET=(\S+)$/m.exec(file(s))?.[1]
    expect(stored, 'the value must survive a failed put').toMatch(/^[A-Za-z0-9_-]{43}$/)
    s.sim.failBulk = false
    before(s)
    expect(await run(s, ONLY_SECRETS)).toBe(0)
    expect(bulks(s)).toEqual([{ AUTH_SECRET: stored }])
    expect(file(s).match(/^AUTH_SECRET=/gm)).toHaveLength(1)
    expect(surface(s)).not.toContain(stored!)
  })

  it("(b) file only: the file's value is put; nothing is generated or written", async () => {
    const s = world({ ...recorded(), secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET_43}\n` })
    const text = file(s)
    expect(await run(s, ONLY_SECRETS)).toBe(0)
    expect(bulks(s)).toEqual([{ AUTH_SECRET: SECRET_43 }])
    expect(file(s)).toBe(text)
    expect(surface(s)).not.toContain(SECRET_43)
  })

  it('(c) both: no write and no put', async () => {
    const r = recorded()
    const s = world({
      ...r,
      secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET_43}\n`,
      sim: { ...r.sim, secrets: ['AUTH_SECRET'] },
    })
    const text = file(s)
    expect(await run(s, ONLY_SECRETS)).toBe(0)
    expect(row(s, 'secrets').status).toBe('ok')
    expect(bulks(s)).toEqual([])
    expect(file(s)).toBe(text)
  })

  it('(d) Worker only: nothing generated, nothing written, nothing put, and a `manual` step that names the file', async () => {
    const r = recorded()
    const s = world({ ...r, sim: { ...r.sim, secrets: ['AUTH_SECRET'] } })
    const text = file(s)
    expect(await run(s, ONLY_SECRETS)).toBe(0)
    expect(bulks(s)).toEqual([])
    expect(file(s)).toBe(text)
    const m = row(s, 'secrets')
    expect(m.status).toBe('manual')
    expect(m.detail).toBe(
      `AUTH_SECRET is set on the Worker but not in ${s.w.secretsPath}: owner-reset needs it; copy it in if you have it`,
    )
    expect(s.w.out.join('\n')).toMatch(/manual:\n\s+secrets: AUTH_SECRET is set on the Worker/)
  })

  it('--rotate-secrets never replaces AUTH_SECRET (present on both sides, and Worker only)', async () => {
    const r = recorded()
    const both = world({
      ...r,
      secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET_43}\n`,
      sim: { ...r.sim, secrets: ['AUTH_SECRET'] },
    })
    expect(await run(both, [...ONLY_SECRETS, '--rotate-secrets'])).toBe(0)
    expect(bulks(both)).toEqual([])
    const only = world({ ...r, sim: { ...r.sim, secrets: ['AUTH_SECRET'] } })
    const text = file(only)
    expect(await run(only, [...ONLY_SECRETS, '--rotate-secrets'])).toBe(0)
    expect(bulks(only)).toEqual([])
    expect(file(only)).toBe(text)
  })

  it('a dry run reports state (a) and writes and puts nothing', async () => {
    const s = world(recorded())
    const text = file(s)
    expect(await run(s, [...ONLY_SECRETS, '--dry-run'])).toBe(0)
    expect(row(s, 'secrets').status).toBe('create')
    expect(row(s, 'secrets').detail).toMatch(/AUTH_SECRET/)
    expect(file(s)).toBe(text)
    expect(bulks(s)).toEqual([])
  })

  it('a file value that the Worker would refuse (under 32 characters) is refused (exit 2) before any step', async () => {
    const s = world({ secretsText: `${SECRETS_TEXT}AUTH_SECRET=short\n` })
    expect(await run(s)).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/AUTH_SECRET/)
    expect(s.w.wrangler).toEqual([])
  })
})

describe('4. the Google pair (D4)', () => {
  it('both values are put as Worker secrets, beside AUTH_SECRET', async () => {
    const s = world({
      ...recorded(),
      secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET_43}\nAUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=gsecret-CANARY-0123\n`,
    })
    expect(await run(s, ONLY_SECRETS), s.w.all()).toBe(0)
    expect(bulks(s)).toEqual([
      {
        AUTH_SECRET: SECRET_43,
        AUTH_GOOGLE_CLIENT_ID: 'gid-1.apps.googleusercontent.com',
        AUTH_GOOGLE_CLIENT_SECRET: 'gsecret-CANARY-0123',
      },
    ])
    expect(surface(s)).not.toContain('gsecret-CANARY-0123')
  })
  it.each([
    ['AUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com', 'AUTH_GOOGLE_CLIENT_SECRET'],
    ['AUTH_GOOGLE_CLIENT_SECRET=gsecret-0123456789', 'AUTH_GOOGLE_CLIENT_ID'],
  ])('%s alone is refused (exit 2) before any step, naming %s', async (half, missing) => {
    const s = world({ secretsText: `${SECRETS_TEXT}${half}\n` })
    expect(await run(s)).toBe(2)
    expect(s.w.err.join('\n')).toContain(missing)
    expect(s.w.all()).not.toContain('gsecret-0123456789')
    expect(s.w.wrangler).toEqual([])
    expect(s.w.fetchUrls).toEqual([])
  })
  it('without either, nothing Google is put', async () => {
    const s = world(recorded())
    expect(await run(s, ONLY_SECRETS)).toBe(0)
    expect(Object.keys(bulks(s)[0]!)).toEqual(['AUTH_SECRET'])
  })
})

describe('5. the bootstrap step on better-auth (D6)', () => {
  it('writes the marker better-auth:<env>, the control marker, the vibase-cli seed named by PUBLIC_BASE_URL and the owner invitation', async () => {
    const s = world()
    expect(await run(s), s.w.all()).toBe(0)
    expect(row(s, 'bootstrap').status).toBe('create')
    const [dep] = await rowsOf(pair.d1, 'select organization_id, auth_provider, auth_org_id from deployment')
    expect(dep).toMatchObject({ auth_provider: 'better-auth', auth_org_id: 'demo' })
    expect((await readControlMarker(openControlDb(pair.control)))?.organizationId).toBe(dep!.organization_id)
    expect(
      await rowsOf(pair.control, "select client_id from auth_oauth_clients where client_id = 'vibase-cli'"),
    ).toHaveLength(1)
    expect(
      (
        await rowsOf(
          pair.control,
          "select resource_id from auth_oauth_client_resources where client_id = 'vibase-cli' order by resource_id",
        )
      ).map((r) => r.resource_id),
    ).toEqual([BASE, `${BASE}/mcp`])
    expect(await rowsOf(pair.control, 'select email, role, accepted_at, revoked_at from invitations')).toEqual([
      { email: OWNER, role: 'owner', accepted_at: null, revoked_at: null },
    ])
    expect(await rowsOf(pair.d1, 'select * from users')).toEqual([])
  })

  it('the owner invitation is the last write: it comes after the organisation and the control marker', async () => {
    const s = world()
    await run(s)
    const [inv] = await rowsOf(pair.control, 'select created_at from invitations')
    const [org] = await rowsOf(pair.d1, 'select created_at from organizations')
    expect(inv!.created_at >= org!.created_at).toBe(true)
    expect(
      await rowsOf(pair.control, "select action from control_audit where action = 'invitation.created'"),
    ).toHaveLength(1)
  })

  it('a new instance without --owner-email is refused (exit 2) before any step', async () => {
    const s = world()
    expect(await run(s, ['--env', 'demo', '--api-host', API_HOST])).toBe(2)
    expect(s.w.err.join('\n')).toContain('--owner-email')
    expect(s.w.wrangler).toEqual([])
  })

  it('a recorded instance with no owner and no live invitation fails at the step when --owner-email is missing, and writes no invitation', async () => {
    const s = world()
    await run(s)
    await pair.control.prepare('delete from invitations').run()
    await s.sync()
    before(s)
    expect(await run(s, ['--env', 'demo', '--api-host', API_HOST])).toBe(3)
    expect(row(s, 'bootstrap').status).toBe('fail')
    expect(row(s, 'bootstrap').detail).toContain('--owner-email')
    expect(await rowsOf(pair.control, 'select * from invitations')).toEqual([])
  })

  it.each([
    ['none', { authProvider: 'none', authOrgId: 'demo', email: 'x@example.com', agentName: 'a' }],
    ['clerk', { authProvider: 'clerk', authOrgId: 'https://c.example.com' }],
  ])('a %s: marker is refused (exit 3), whatever else is in the database', async (provider, link) => {
    // The agent's key needs a control database; a scratch one keeps the real pair's marker untouched.
    await bootstrapD1(pair.d1, { organizationName: 'Acme', ...link }, { control: openControlDb(memoryControl()) })
    const s = world({ sim: { marker: await readMarker(pair.d1) } })
    expect(await run(s)).toBe(3)
    expect(row(s, 'bootstrap').status).toBe('fail')
    expect(row(s, 'bootstrap').detail).toContain(`marked ${provider}:`)
    expect(await rowsOf(pair.control, 'select * from invitations')).toEqual([])
  })

  it('an operator agent on better-auth gets its key in the secrets file, never in the output', async () => {
    const s = world()
    expect(await run(s, [...ARGS, '--operator-agent', 'operator', '--key-env', 'DEMO_KEY']), s.w.all()).toBe(0)
    const key = /^DEMO_KEY=(\S+)$/m.exec(file(s))?.[1]
    expect(key).toBeTruthy()
    expect(surface(s)).not.toContain(key!)
    expect(await rowsOf(pair.d1, 'select * from api_keys')).toHaveLength(0)
    expect(await rowsOf(pair.control, 'select * from api_keys')).toHaveLength(1)
    expect(await rowsOf(pair.control, "select * from control_audit where action = 'api_key.created'")).toHaveLength(1)
  })
})

describe('6. re-runs and the one-time link (D7)', () => {
  const invitationRows = () => rowsOf(pair.control, 'select * from invitations')
  const auditRows = () => rowsOf(pair.control, "select * from control_audit where action like 'invitation.%'")

  it("none: the run issues one invitation and prints its URL once, in the bootstrap step's lines", async () => {
    const s = world()
    expect(await run(s)).toBe(0)
    expect(urlLines(s)).toHaveLength(1)
    expect(urlLines(s)[0]).toContain(`${BASE}/invite#token=`)
    expect(await invitationRows()).toHaveLength(1)
  })

  it('pending: a re-run issues nothing, writes no row and no audit row, names the email and the expiry, and prints no URL', async () => {
    const s = world()
    await run(s)
    const token = tokenOf(s)!
    const [first] = await invitationRows()
    const audits = (await auditRows()).length
    before(s)
    expect(await run(s)).toBe(0)
    const b = row(s, 'bootstrap')
    expect(b.status).toBe('ok')
    expect(b.detail).toContain(`owner invitation pending for ${OWNER} (expires ${first!.expires_at})`)
    expect(b.detail).toContain(`a new link: vibase-server owner-reset --env demo --email ${OWNER}`)
    expect(await invitationRows()).toEqual([first])
    expect(await auditRows()).toHaveLength(audits)
    expect(urlLines(s)).toEqual([])
    for (const text of [s.w.all(), s.settings() ?? '', file(s)]) expect(text).not.toContain(token)
  })

  it('owner exists: ok, nothing is issued, no row changes', async () => {
    const s = world()
    await run(s)
    const [org] = await rowsOf(pair.d1, 'select id from organizations')
    const user = '0190b2c4-0000-7000-8000-00000000c001'
    await seedPrincipal(pair.d1, { id: user, kind: 'user', email: OWNER })
    await seedMembership(pair.d1, { organizationId: org!.id, userId: user, role: 'owner' })
    await s.sync()
    const snapshot = JSON.stringify({ i: await invitationRows(), a: await auditRows() })
    before(s)
    expect(await run(s)).toBe(0)
    expect(row(s, 'bootstrap').status).toBe('ok')
    expect(row(s, 'bootstrap').detail).toMatch(/owner/)
    expect(JSON.stringify({ i: await invitationRows(), a: await auditRows() })).toBe(snapshot)
    expect(urlLines(s)).toEqual([])
  })

  it('an initialised instance with no owner and no live invitation (a run that stopped before the invitation): the re-run issues one', async () => {
    const s = world()
    await run(s)
    await pair.control.prepare('delete from invitations').run()
    await s.sync()
    before(s)
    expect(await run(s)).toBe(0)
    expect(row(s, 'bootstrap').status).toBe('create')
    expect(await invitationRows()).toHaveLength(1)
    expect(urlLines(s)).toHaveLength(1)
  })

  describe('dry runs', () => {
    it('none: reports it would issue, issues nothing, prints no URL', async () => {
      const s = world()
      await run(s)
      await pair.control.prepare('delete from invitations').run()
      await s.sync()
      const audits = (await auditRows()).length
      before(s)
      expect(await run(s, [...ARGS, '--dry-run'])).toBe(0)
      expect(row(s, 'bootstrap').status).toBe('create')
      expect(row(s, 'bootstrap').detail).toMatch(/would issue an owner invitation for owner@example.com/)
      expect(await invitationRows()).toEqual([])
      expect(await auditRows()).toHaveLength(audits)
      expect(urlLines(s)).toEqual([])
    })
    it('pending: reports the pending invitation and issues nothing', async () => {
      const s = world()
      await run(s)
      const snapshot = await invitationRows()
      before(s)
      expect(await run(s, [...ARGS, '--dry-run'])).toBe(0)
      expect(row(s, 'bootstrap').detail).toContain(`owner invitation pending for ${OWNER}`)
      expect(row(s, 'bootstrap').detail).toContain(`a new link: vibase-server owner-reset --env demo --email ${OWNER}`)
      expect(await invitationRows()).toEqual(snapshot)
    })
    it('owner exists: reports it and issues nothing', async () => {
      const s = world()
      await run(s)
      const [org] = await rowsOf(pair.d1, 'select id from organizations')
      const user = '0190b2c4-0000-7000-8000-00000000c002'
      await seedPrincipal(pair.d1, { id: user, kind: 'user', email: OWNER })
      await seedMembership(pair.d1, { organizationId: org!.id, userId: user, role: 'owner' })
      await s.sync()
      const snapshot = await invitationRows()
      before(s)
      expect(await run(s, [...ARGS, '--dry-run'])).toBe(0)
      expect(row(s, 'bootstrap').status).toBe('ok')
      expect(await invitationRows()).toEqual(snapshot)
    })
  })
})
