// OPS496 on `vibase-server setup`: verify through the Cloudflare API (D1), the one bounded `/health` read (D2, D3), no request to the host before verify (D4) and the closing block (D5).
// Everything runs against the setup kit's fake wrangler and fake `fetch` (its Cloudflare API answers follow decision 496.8's probed shapes), real settings and secrets files, and two real local D1s.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { ALL_MIGRATIONS, API_HOST, setupWorld, type Sim, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runSetup } from './setup.js'
import { managedSecretNames, type SetupCtx } from './setup-steps.js'
import { CONTROL_ALL, CONTROL_UUID, PKG_COMMIT, SECRETS_TEXT, UUID, cleanup, controlSettings } from './test-kit.js'

const BASE = `https://${API_HOST}`
const OWNER = 'owner@example.com'
const ARGS = ['--env', 'demo', '--api-host', API_HOST, '--owner-email', OWNER]
const BA_VARS = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, CORS_ALLOWED_ORIGINS: '' }
const NONE_VARS = { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' }
const GOOGLE = 'AUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=gsecret-0123456789\n'
const GMAIL = `GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=gsecret-0123456789\nOAUTH_STATE_SECRET=state-0123456789\nCREDENTIALS_KEY=${Buffer.alloc(32, 7).toString('base64')}\n`
const DNS_LINE = `It can take a few minutes for DNS to propagate before ${BASE} is reachable.`

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
const pkgVersion = (s: SetupWorld): string =>
  (JSON.parse(readFileSync(join(s.w.pkg.dir, 'release.json'), 'utf8')) as { version: string }).version

/** An instance recorded, created, migrated and deployed at the package's build. */
function deployed(
  o: { vars?: Record<string, string>; secretsText?: string; sim?: Partial<Sim>; answerHealth?: () => Response } = {},
): SetupWorld {
  const s = world({
    ...(o.answerHealth
      ? { interceptFetch: (url: string) => (url === `${BASE}/health` ? o.answerHealth!() : undefined) }
      : {}),
    settings: controlSettings({ vars: o.vars ?? BA_VARS }),
    secretsText: o.secretsText ?? SECRETS_TEXT,
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
  if (!(o.sim && 'deployed' in o.sim)) s.sim.deployed = { version: pkgVersion(s), commit: PKG_COMMIT }
  return s
}
const verifyOnly = (s: SetupWorld, extra: string[] = []) => run(s, [...ARGS, '--only', 'verify', ...extra])
/** The Cloudflare API reads of this run, as the path after `accounts/<id>/`. */
const apiPaths = (s: SetupWorld): string[] =>
  s.w.fetchUrls.flatMap((u) =>
    u.startsWith('https://api.cloudflare.com/') ? [u.replace(/^.*\/accounts\/[^/]+\//, '')] : [],
  )
/** Verify's own reads: the first Worker-settings read of a run is the newer-live check before the question (D4), so it is left out. */
const reads = (s: SetupWorld) =>
  apiPaths(s)
    .filter((p) => /^(workers\/(scripts|domains)|r2\/buckets)/.test(p))
    .slice(1)
const hostCalls = (s: SetupWorld, path = '') => s.w.fetchUrls.filter((u) => u.startsWith(`${BASE}${path}`)).length
const trackerReads = (s: SetupWorld) => s.w.wrangler.filter((c) => c.args.includes('execute')).length
const SETTINGS = 'workers/scripts/vault-demo/settings'
const DOMAINS = 'workers/domains?service=vault-demo'
const BUCKET = 'r2/buckets/vault-demo-bodies'

describe('D1: the API checks, in order, the first failure fails verify (the matrix)', () => {
  type Case = {
    name: string
    sim: (s: SetupWorld) => Partial<Sim>
    detail: RegExp
    /** The API reads that ran, and so no later one. */
    paths: string[]
    trackers?: number
  }
  const CASES: Case[] = [
    {
      name: 'Worker absent (10007)',
      sim: () => ({ deployed: null }),
      detail: /Worker check failed: Worker vault-demo not found/,
      paths: [SETTINGS],
    },
    {
      name: 'VERSION differs',
      sim: () => ({ deployed: { version: '0.0.1', commit: PKG_COMMIT } }),
      detail: /Worker check failed: VERSION is 0\.0\.1, the package is /,
      paths: [SETTINGS],
    },
    {
      name: 'COMMIT differs',
      sim: (s) => ({ deployed: { version: pkgVersion(s), commit: 'deadbeef' } }),
      detail: /Worker check failed: COMMIT is deadbeef, the package is abc1234/,
      paths: [SETTINGS],
    },
    {
      name: 'a recorded var differs (its deployed value in the detail)',
      sim: () => ({ deployedVars: { ...BA_VARS, PUBLIC_BASE_URL: 'https://old.example.com' } }),
      detail:
        /Worker check failed: variable PUBLIC_BASE_URL is "https:\/\/old\.example\.com" on the Worker, recorded "https:\/\/api\.demo\.invalid"/,
      paths: [SETTINGS],
    },
    {
      name: 'a managed secret is missing',
      sim: () => ({ apiSecrets: ['SOMETHING_ELSE'] }),
      detail: /secrets check failed: AUTH_SECRET is not on the Worker/,
      paths: [SETTINGS],
    },
    {
      name: 'the custom domain is not listed',
      sim: () => ({ domains: ['other.example.com'] }),
      detail: /host check failed: custom domain api\.demo\.invalid is not attached to vault-demo/,
      paths: [SETTINGS, DOMAINS],
    },
    {
      name: 'the control tracker is behind',
      sim: () => ({ controlApplied: [CONTROL_ALL[0]!] }),
      detail: /migrations check failed: the control database is behind, not current/,
      paths: [SETTINGS, DOMAINS],
      trackers: 1,
    },
    {
      name: 'the CRM tracker is behind (control read first)',
      sim: () => ({ applied: [ALL_MIGRATIONS[0]!] }),
      detail: /migrations check failed: the crm database is behind, not current/,
      paths: [SETTINGS, DOMAINS],
      trackers: 2,
    },
    {
      name: 'the bucket is absent',
      sim: () => ({ r2s: [] }),
      detail: /bucket check failed: R2 bucket vault-demo-bodies not found/,
      paths: [SETTINGS, DOMAINS, BUCKET],
      trackers: 2,
    },
    ...[
      [
        'the Worker settings',
        'scripts/vault-demo/settings',
        [SETTINGS],
        /Worker check failed: Worker settings read failed: HTTP 403/,
      ],
      [
        'the domains',
        'workers/domains',
        [SETTINGS, DOMAINS],
        /host check failed: custom domains read failed: HTTP 403/,
      ],
      ['the bucket', 'r2/buckets', [SETTINGS, DOMAINS, BUCKET], /bucket check failed: R2 bucket read failed: HTTP 403/],
    ].map(
      ([n, match, paths, detail]): Case => ({
        name: `a read answering 403 (${n as string})`,
        sim: () => ({ apiStatus: [{ match: match as string, status: 403 }] }),
        detail: detail as RegExp,
        paths: paths as string[],
        trackers: n === 'the bucket' ? 2 : undefined,
      }),
    ),
  ]
  it.each(CASES)('$name: exit 3 naming the check, no later check and no host request', async (c) => {
    const s = deployed()
    Object.assign(s.sim, c.sim(s))
    expect(await verifyOnly(s)).toBe(3)
    expect(row(s, 'verify').status).toBe('fail')
    expect(row(s, 'verify').detail).toMatch(c.detail)
    expect(reads(s)).toEqual(c.paths)
    expect(trackerReads(s)).toBe(c.trackers ?? 0)
    expect(hostCalls(s)).toBe(0)
  })

  it('all pass: verify goes on to the one /health read', async () => {
    const s = deployed()
    expect(await verifyOnly(s), s.w.all()).toBe(0)
    expect(reads(s)).toEqual([SETTINGS, DOMAINS, BUCKET])
    expect(hostCalls(s, '/health')).toBe(1)
  })

  it('a short and a full sha of the same commit pass; an extra secret on the Worker is ignored', async () => {
    const s = deployed({ sim: { apiSecrets: ['AUTH_SECRET', 'SOMETHING_ELSE'] } })
    s.sim.deployed = { version: pkgVersion(s), commit: `${PKG_COMMIT}${'0'.repeat(33)}` }
    expect(await verifyOnly(s), s.w.all()).toBe(0)
  })

  it('a dry run with steps pending stays blocked: the reads happened and none of them failed it', async () => {
    const s = deployed({ sim: { deployed: { version: '0.0.1', commit: PKG_COMMIT } } })
    expect(await run(s, [...ARGS, '--dry-run']), s.w.all()).toBe(0)
    expect(row(s, 'deploy').status).toBe('update')
    expect(row(s, 'verify').status).toBe('blocked')
    expect(reads(s)).toContain(SETTINGS)
    expect(hostCalls(s)).toBe(0)
  })

  it('a dry run with nothing pending reads the same and fails like a real run', async () => {
    const s = deployed({ sim: { r2s: [] } })
    expect(await run(s, [...ARGS, '--only', 'verify', '--dry-run'])).toBe(3)
    expect(row(s, 'verify').detail).toMatch(/bucket check failed/)
  })
})

describe('D1 (b): the secrets each auth mode manages', () => {
  const names = (c: Partial<SetupCtx['opts']> & { ba?: unknown; gmail?: boolean }) =>
    managedSecretNames({
      opts: { auth: c.auth ?? 'none' },
      betterAuth: c.ba,
      gmail: c.gmail ? {} : null,
    } as unknown as SetupCtx)
  it('Clerk: the pair; Better Auth: AUTH_SECRET, plus the Google pair when set; none: nothing; the Gmail group on top', () => {
    expect(names({ auth: 'clerk' })).toEqual(['CLERK_SECRET_KEY', 'CLERK_JWT_KEY'])
    expect(names({ auth: 'better-auth', ba: {} })).toEqual(['AUTH_SECRET'])
    expect(names({ auth: 'better-auth', ba: { google: {} } })).toEqual([
      'AUTH_SECRET',
      'AUTH_GOOGLE_CLIENT_ID',
      'AUTH_GOOGLE_CLIENT_SECRET',
    ])
    expect(names({ auth: 'none' })).toEqual([])
    expect(names({ auth: 'none', gmail: true })).toEqual([
      'GOOGLE_CLIENT_SECRET',
      'OAUTH_STATE_SECRET',
      'CREDENTIALS_KEY',
    ])
  })
  it('the Google pair set in the secrets file but missing on the Worker fails; the Gmail group likewise', async () => {
    const g = deployed({ secretsText: `${SECRETS_TEXT}${GOOGLE}`, sim: { apiSecrets: ['AUTH_SECRET'] } })
    expect(await verifyOnly(g)).toBe(3)
    expect(row(g, 'verify').detail).toContain(
      'secrets check failed: AUTH_GOOGLE_CLIENT_ID, AUTH_GOOGLE_CLIENT_SECRET are not on the Worker',
    )
    const m = deployed({ secretsText: `${SECRETS_TEXT}${GMAIL}`, sim: { apiSecrets: ['AUTH_SECRET'] } })
    expect(await verifyOnly(m)).toBe(3)
    expect(row(m, 'verify').detail).toContain(
      'GOOGLE_CLIENT_SECRET, OAUTH_STATE_SECRET, CREDENTIALS_KEY are not on the Worker',
    )
  })
})

describe('D2, D3: the one read', () => {
  const DOWN: [string, NonNullable<Sim['hostDown']>][] = [
    ['a DNS error', 'dns'],
    ['a DNS error on the cause', 'dns-cause'],
    ['a connection refusal', 'refused'],
    ['a timeout', 'timeout'],
  ]
  it.each(DOWN)(
    '%s: ok "not reachable yet", exit 0, one /health request, no sleep, no discovery read',
    async (_n, how) => {
      const s = deployed({ sim: { hostDown: how } })
      expect(await verifyOnly(s), s.w.all()).toBe(0)
      expect(row(s, 'verify').status).toBe('ok')
      expect(row(s, 'verify').detail).toContain('not reachable yet')
      expect(row(s, 'verify').detail).toContain('discovery not checked')
      expect(hostCalls(s)).toBe(1)
      expect(hostCalls(s, '/health')).toBe(1)
      expect(s.w.clock.t).toBe(0)
    },
  )

  const health = (over: Record<string, unknown> | string | null, status = 200) =>
    over === null || typeof over === 'string'
      ? new Response(over ?? '', { status })
      : new Response(
          JSON.stringify({ status: 'ok', version: '', commit: PKG_COMMIT, migrations: { status: 'current' }, ...over }),
          { status },
        )
  const WRONG: [string, (s: SetupWorld) => Response, RegExp][] = [
    ['a 5xx', () => health(null, 503), /answered 503/],
    ['a 404', () => health(null, 404), /answered 404/],
    ['a redirect', () => health(null, 302), /answered 302/],
    ['a different commit', (s) => health({ version: pkgVersion(s), commit: 'ffffff0' }), /commit ffffff0/],
    ['a different version', () => health({ version: '0.0.1' }), /version 0\.0\.1/],
    [
      'migrations pending',
      (s) => health({ version: pkgVersion(s), migrations: { status: 'pending' } }),
      /migrations pending/,
    ],
    ['a body that is not a health body', () => health('<html>hi</html>'), /not with a Vibase health body/],
  ]
  it.each(WRONG)('%s fails (exit 3), one request, no discovery read', async (_n, mk, re) => {
    const probe = deployed()
    const s = deployed({ answerHealth: () => mk(probe) })
    expect(await verifyOnly(s)).toBe(3)
    expect(row(s, 'verify').detail).toMatch(re)
    expect(hostCalls(s)).toBe(1)
    expect(s.w.clock.t).toBe(0)
  })
})

describe('D4: no request to the host before verify', () => {
  it('a real run: the first host request comes after the deploy and secrets rows and before verify prints', async () => {
    let firstAt: string[] | undefined
    const s = deployed({ sim: { deployed: { version: '0.0.1', commit: PKG_COMMIT } } })
    const inner = s.w.deps.fetch
    s.w.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(`${BASE}/`)) firstAt ??= s.rows().map((r) => r.step)
      return inner(input, init)
    }) as typeof fetch
    expect(await run(s), s.w.all()).toBe(0)
    expect(firstAt).toBeDefined()
    expect(firstAt).toContain('deploy')
    expect(firstAt).toContain('secrets')
    expect(firstAt).not.toContain('verify')
  })

  it('a dry run makes no host request at all while steps are pending', async () => {
    const s = deployed({ sim: { deployed: { version: '0.0.1', commit: PKG_COMMIT } } })
    expect(await run(s, [...ARGS, '--dry-run']), s.w.all()).toBe(0)
    expect(hostCalls(s)).toBe(0)
  })

  it('a deployed VERSION newer than the package refuses (exit 2), reads the Worker settings, writes nothing and asks for no host', async () => {
    const s = deployed({ sim: { deployed: { version: '99.0.0', commit: PKG_COMMIT } } })
    expect(await run(s)).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/the instance runs 99\.0\.0 and this package is/)
    expect(s.writes()).toEqual([])
    expect(apiPaths(s).some((p) => p.endsWith('/settings'))).toBe(true)
    expect(hostCalls(s)).toBe(0)
  })

  it('a missing Worker is no live instance: no refusal, and the deploy runs', async () => {
    const s = deployed({ sim: { deployed: null } })
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.writes().some((a) => a[0] === 'deploy')).toBe(true)
    expect(row(s, 'deploy').detail).toContain('was no Worker')
  })

  it('deploy is ok without a wrangler deploy only when the build and every recorded var match', async () => {
    const s = deployed()
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.writes().some((a) => a[0] === 'deploy')).toBe(false)
    expect(row(s, 'deploy').status).toBe('ok')
  })

  it('one recorded var differing deploys (and the deploy carries it, so verify then passes)', async () => {
    const s = deployed({ sim: { deployedVars: { ...BA_VARS, CORS_ALLOWED_ORIGINS: 'https://old.example.com' } } })
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.writes().some((a) => a[0] === 'deploy')).toBe(true)
    expect(row(s, 'deploy').detail).toContain('variables differ: CORS_ALLOWED_ORIGINS')
  })

  it('a host move still deploys at an unchanged build', async () => {
    const s = deployed({ vars: NONE_VARS })
    const argv = ['--env', 'demo', '--auth', 'none', '--api-host', 'api2.demo.invalid', '--change-host']
    expect(await run(s, argv), s.w.all()).toBe(0)
    expect(s.writes().some((a) => a[0] === 'deploy')).toBe(true)
  })
})

describe('D5: the closing block', () => {
  const seedOwner = async (s: SetupWorld) => {
    const [org] = ((await pair.d1.prepare('select id from organizations').all()).results ?? []) as { id: string }[]
    await seedPrincipal(pair.d1, { id: '0190b2c4-0000-7000-8000-00000000c001', kind: 'user', email: OWNER })
    await seedMembership(pair.d1, {
      organizationId: org!.id,
      userId: '0190b2c4-0000-7000-8000-00000000c001',
      role: 'owner',
    })
    await s.sync()
  }
  const reset = (s: SetupWorld) => {
    s.w.out.length = 0
    s.w.err.length = 0
  }

  it('an invitation issued in this run: the Claim block after "setup: done"', async () => {
    const s = world()
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.w.out.indexOf('=== Claim your instance ===')).toBeGreaterThan(s.w.out.indexOf('setup: done'))
    expect(s.w.out.join('\n')).not.toContain('No owner invitation was issued')
  })

  it('an owner exists: the "no invitation" block with the owner-reset command, last', async () => {
    const s = world()
    await run(s)
    await seedOwner(s)
    reset(s)
    expect(await run(s), s.w.all()).toBe(0)
    const out = s.w.out
    expect(out.slice(-3)).toEqual([
      '',
      'No owner invitation was issued in this run: an owner exists.',
      'To recover access: vibase-server owner-reset --env demo',
    ])
    expect(out.indexOf('setup: done')).toBeLessThan(out.length - 3)
    expect(out.join('\n')).not.toContain('=== Claim')
  })

  it('an invitation pending: the block names its email and expiry and the --email command', async () => {
    const s = world()
    await run(s)
    const [inv] = ((await pair.control.prepare('select expires_at from invitations').all()).results ?? []) as {
      expires_at: string
    }[]
    reset(s)
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.w.out.slice(-3)).toEqual([
      '',
      `No owner invitation was issued in this run: an owner invitation for ${OWNER} is pending (expires ${inv!.expires_at}).`,
      `A new link: vibase-server owner-reset --env demo --email ${OWNER}`,
    ])
  })

  it('a failure after the bootstrap step still prints the block; a failure before it prints none', async () => {
    const after = world({ sim: { failDeploy: true } })
    expect(await run(after)).toBe(3)
    expect(after.w.out.indexOf('=== Claim your instance ===')).toBeGreaterThan(-1)
    const ownerAfter = world()
    await run(ownerAfter)
    await seedOwner(ownerAfter)
    ownerAfter.sim.deployed = { version: '0.0.1', commit: PKG_COMMIT }
    ownerAfter.sim.failDeploy = true
    reset(ownerAfter)
    expect(await run(ownerAfter)).toBe(3)
    expect(ownerAfter.w.out.at(-1)).toBe('To recover access: vibase-server owner-reset --env demo')
    const before = world({ sim: { failApply: true } })
    expect(await run(before)).toBe(3)
    expect(before.w.out.join('\n')).not.toMatch(/Claim your instance|No owner invitation/)
  })

  it('none prints no owner block', async () => {
    const s = world()
    expect(await run(s, ['--env', 'demo', '--api-host', API_HOST, '--auth', 'none']), s.w.all()).toBe(0)
    expect(s.w.out.join('\n')).not.toMatch(/Claim your instance|No owner invitation/)
  })

  it('the DNS line is the very last line for a custom domain with no answer, after the Claim block', async () => {
    const s = world({ sim: { hostDown: 'dns' } })
    expect(await run(s), s.w.all()).toBe(0)
    expect(s.w.out.at(-1)).toBe(DNS_LINE)
    expect(s.w.out.indexOf('=== Claim your instance ===')).toBeLessThan(s.w.out.length - 1)
  })

  it('no DNS line for a custom domain that answered', async () => {
    const s = world()
    await run(s)
    expect(s.w.out.join('\n')).not.toContain('DNS')
  })

  it('a dry run prints none of it', async () => {
    const s = world({ sim: { hostDown: 'dns' } })
    expect(await run(s, [...ARGS, '--dry-run']), s.w.all()).toBe(0)
    expect(s.w.out.join('\n')).not.toMatch(/Claim your instance|No owner invitation|DNS/)
  })
})
