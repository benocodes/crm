import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPlanPath, realFileDeps, runAuthMigrate, type PlanDeps } from './auth-migrate-remote.js'
import {
  CLERK_SECRET,
  KEY_HASH,
  fakeClerk,
  fakeWrangler,
  standardClerk,
  standardWorld,
  type World,
} from './auth-migrate/test-kit.js'
import type { AuthPlan } from './auth-migrate/types.js'
import { REPO_ROOT } from './remote.js'
import { isReadOnlySql } from './sweep-counts-kit.js'

const CRM_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CTL_ID = '9f8e7d6c-5b4a-4398-8765-4321fedcba98'
const config = (over: { vars?: Record<string, unknown>; control?: boolean; crmId?: string; name?: string } = {}) => ({
  name: over.name ?? 'vault-hq',
  d1_databases: [
    { binding: 'DB', database_name: 'vault-crm-hq', database_id: over.crmId ?? CRM_ID, remote: true },
    ...(over.control === false
      ? []
      : [{ binding: 'CONTROL_DB', database_name: 'vault-control-hq', database_id: CTL_ID, remote: true }]),
  ],
  vars: over.vars ?? { AUTH_PROVIDER: 'clerk' },
})
const BOOKMARKS = { 'vault-crm-hq': 'BOOKMARK-CRM-0001', 'vault-control-hq': 'BOOKMARK-CONTROL-0002' }
const ENV_OK = { display: '.env.hq', status: 'ok' as const, text: `CLERK_SECRET_KEY=${CLERK_SECRET}\nOTHER=x\n` }

function kit(
  o: {
    world?: World
    clerk?: Array<Record<string, any>>
    cfg?: ReturnType<typeof config>
    env?: PlanDeps extends never ? never : ReturnType<PlanDeps['readInstanceEnv']>
    clerkCap?: number
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'auth-plan-'))
  const wrangler = fakeWrangler(o.world ?? standardWorld(), BOOKMARKS)
  const clerk = fakeClerk(o.clerk ?? standardClerk(), o.clerkCap ?? 2)
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  let n = 0
  const deps: PlanDeps = {
    ...realFileDeps,
    loadEnv: () => void calls.push('loadEnv'),
    readConfig: () => o.cfg ?? config(),
    readInstanceEnv: () => o.env ?? ENV_OK,
    exec: wrangler.exec,
    fetch: clerk.fetch,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
    newId: () => `0190cccc-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  }
  const plan = join(dir, 'hq.auth-plan.json')
  return { dir, plan, deps, wrangler, clerk, out, err, calls }
}
const GOOD = { CONFIRM_REMOTE: '1' }
const IN_REPO = join(REPO_ROOT, 'packages', 'auth-plan-ops365-test.json')
// a broken ignore check would write here: never leave it behind
afterEach(() => rmSync(IN_REPO, { force: true }))

// [[OPS365]] group 1: every refusal happens before any call, exits 1 and writes nothing.
describe('auth:migrate:remote plan refuses first', () => {
  const cases: Array<
    [
      string,
      (k: ReturnType<typeof kit>) => { argv: string[]; env: NodeJS.ProcessEnv; k?: ReturnType<typeof kit> },
      RegExp,
    ]
  > = [
    ['no CONFIRM_REMOTE=1', (k) => ({ argv: ['plan', '--env', 'hq', '--plan', k.plan], env: {} }), /CONFIRM_REMOTE=1/],
    ['no --env', (k) => ({ argv: ['plan', '--plan', k.plan], env: GOOD }), /--env/],
    [
      'an env with no record',
      (k) => ({
        argv: ['plan', '--env', 'nope', '--plan', k.plan],
        env: GOOD,
        k: kit({ cfg: config({ name: 'vb' }) }),
      }),
      /unknown env/,
    ],
    [
      'a placeholder database id',
      (k) => ({
        argv: ['plan', '--env', 'hq', '--plan', k.plan],
        env: GOOD,
        k: kit({ cfg: config({ crmId: '00000000-0000-0000-0000-000000000000' }) }),
      }),
      /placeholder/,
    ],
    [
      'no recorded control database',
      (k) => ({
        argv: ['plan', '--env', 'hq', '--plan', k.plan],
        env: GOOD,
        k: kit({ cfg: config({ control: false }) }),
      }),
      /CONTROL_DB/,
    ],
    [
      'a better-auth instance',
      (k) => ({
        argv: ['plan', '--env', 'hq', '--plan', k.plan],
        env: GOOD,
        k: kit({ cfg: config({ vars: { AUTH_PROVIDER: 'better-auth' } }) }),
      }),
      /clerk/,
    ],
    [
      'an instance on provider none',
      (k) => ({ argv: ['plan', '--env', 'hq', '--plan', k.plan], env: GOOD, k: kit({ cfg: config({ vars: {} }) }) }),
      /clerk/,
    ],
    [
      'no CLERK_SECRET_KEY in .env.<env>',
      (k) => ({
        argv: ['plan', '--env', 'hq', '--plan', k.plan],
        env: GOOD,
        k: kit({ env: { display: '.env.hq', status: 'ok', text: 'OTHER=x\n' } }),
      }),
      /CLERK_SECRET_KEY/,
    ],
    [
      'no .env.<env> file',
      (k) => ({
        argv: ['plan', '--env', 'hq', '--plan', k.plan],
        env: GOOD,
        k: kit({ env: { display: '.env.hq', status: 'missing' } }),
      }),
      /\.env\.hq/,
    ],
    [
      'an .env.<env> git does not ignore',
      (k) => ({
        argv: ['plan', '--env', 'hq', '--plan', k.plan],
        env: GOOD,
        k: kit({ env: { display: '.env.hq', status: 'not-ignored' } }),
      }),
      /not ignored/,
    ],
    [
      'a plan path that already exists',
      (k) => {
        writeFileSync(k.plan, 'precious')
        return { argv: ['plan', '--env', 'hq', '--plan', k.plan], env: GOOD }
      },
      /already exists/,
    ],
    [
      'a plan path in the repo that git does not ignore',
      () => {
        const k2 = kit()
        return {
          argv: ['plan', '--env', 'hq', '--plan', IN_REPO],
          env: GOOD,
          k: k2,
        }
      },
      /not ignored by git/,
    ],
    [
      'a subcommand that is not built yet',
      (k) => ({ argv: ['revert', '--env', 'hq', '--plan', k.plan], env: GOOD }),
      /plan/,
    ],
  ]
  for (const [title, build, message] of cases) {
    it(`${title}: exit 1, the message, no wrangler or Clerk call, no file`, async () => {
      const base = kit()
      const c = build(base)
      const k = c.k ?? base
      const before = readdirSync(k.dir)
      const code = await runAuthMigrate(c.argv, c.env, k.deps)
      expect(code).toBe(1)
      expect(k.err.join('\n')).toMatch(message)
      expect(k.wrangler.cmds).toEqual([])
      expect(k.clerk.calls).toEqual([])
      expect(readdirSync(k.dir)).toEqual(before) // the existing file, if the case made one, is untouched
      if (title.startsWith('a plan path that already exists')) expect(readFileSync(k.plan, 'utf8')).toBe('precious')
      expect(existsSync(IN_REPO)).toBe(false)
      expect([...k.out, ...k.err].join('\n')).not.toContain(CLERK_SECRET)
    })
  }
})

describe('the plan path', () => {
  it('defaults to $XDG_CONFIG_HOME/vibase/instances/<env>.auth-plan.json, else ~/.config', () => {
    expect(defaultPlanPath('hq', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/u')).toBe(
      '/x/cfg/vibase/instances/hq.auth-plan.json',
    )
    expect(defaultPlanPath('hq', {}, '/home/u')).toBe('/home/u/.config/vibase/instances/hq.auth-plan.json')
  })
  it('the default is created (directory too), mode 600, and a second run refuses to overwrite it', async () => {
    const k = kit()
    const env = { ...GOOD, XDG_CONFIG_HOME: join(k.dir, 'cfg') }
    expect(await runAuthMigrate(['plan', '--env', 'hq'], env, k.deps)).toBe(0)
    const path = join(k.dir, 'cfg', 'vibase', 'instances', 'hq.auth-plan.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const first = readFileSync(path, 'utf8')
    const again = kit()
    expect(await runAuthMigrate(['plan', '--env', 'hq'], env, again.deps)).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(first)
  })
  it('realFileDeps.repoPathNotIgnored: inside the repo and not ignored is true; ignored or outside is false', () => {
    expect(realFileDeps.repoPathNotIgnored(join(REPO_ROOT, 'packages', 'x-plan.json'))).toBe(true)
    expect(realFileDeps.repoPathNotIgnored(join(REPO_ROOT, '.env.hq-plan'))).toBe(false)
    expect(realFileDeps.repoPathNotIgnored(join(tmpdir(), 'plan.json'))).toBe(false)
  })
})

// group 4: the plan file holds what apply and revert need, and no secret.
describe('the plan file', () => {
  async function planned() {
    const k = kit()
    const code = await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan], GOOD, k.deps)
    expect(code).toBe(0)
    return { k, plan: JSON.parse(readFileSync(k.plan, 'utf8')) as AuthPlan }
  }

  it('has the shape: env, instance databases with their own bookmark, people, clerk-only, agents and the snapshot', async () => {
    const { plan } = await planned()
    expect(plan).toMatchObject({
      version: 1,
      env: 'hq',
      created_at: '2026-11-16T12:00:00.000Z',
      crm: { database_name: 'vault-crm-hq', database_id: CRM_ID, bookmark: 'BOOKMARK-CRM-0001' },
      control: { database_name: 'vault-control-hq', database_id: CTL_ID, bookmark: 'BOOKMARK-CONTROL-0002' },
    })
    expect(plan.crm.bookmark).not.toBe(plan.control.bookmark)
    expect(plan.people).toHaveLength(5)
    expect(plan.agents).toHaveLength(8)
    expect(plan.clerk_only.map((c) => c.clerk_user_id)).toEqual(['user_scrubbede'])
  })

  it('fetches each bookmark for its own database, before any read of the rows', async () => {
    const { k } = await planned()
    const tt = k.wrangler.cmds.filter((c) => c.args.includes('time-travel'))
    expect(tt.map((c) => c.args[c.args.indexOf('time-travel') + 2])).toEqual(['vault-crm-hq', 'vault-control-hq'])
    const firstExecute = k.wrangler.cmds.findIndex((c) => c.args.includes('execute'))
    expect(Math.max(...k.wrangler.cmds.map((c, i) => (c.args.includes('time-travel') ? i : -1)))).toBeLessThan(
      firstExecute,
    )
  })

  it('every new id is a UUIDv7 and they are unique', async () => {
    const k = kit()
    // the real generator, not the fake one
    const { uuidv7 } = await import('@vibase/storage')
    k.deps.newId = () => uuidv7()
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan], GOOD, k.deps)).toBe(0)
    const plan = JSON.parse(readFileSync(k.plan, 'utf8')) as AuthPlan
    const all = [...plan.people.map((p) => p.new_auth_user_id), ...plan.agents.map((a) => a.new_auth_user_id)].filter(
      (x): x is string => x !== null,
    )
    expect(all.length).toBe(4)
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is mode 0600 and carries the snapshot of everything it read', async () => {
    const { k, plan } = await planned()
    expect(statSync(k.plan).mode & 0o777).toBe(0o600)
    expect(plan.snapshot.clerk_users.map((u) => u.id)).toEqual(standardClerk().map((u) => u.id))
    expect(plan.snapshot.users.map((u) => u.id)).toEqual(standardWorld().users.map((u) => u.id))
    expect(plan.snapshot.agents.map((a) => a.id)).toEqual(standardWorld().agents.map((a) => a.id))
    expect(plan.snapshot.memberships).toEqual(standardWorld().memberships)
    expect(plan.snapshot.agents[2]!.scopes).toEqual(['contacts:read', 'notes:write'])
  })

  it('holds no secret: neither the file nor stdout nor stderr has the Clerk key or a key hash', async () => {
    const world = standardWorld()
    // an over-broad read would carry the hash: the fake answers every agent row with one
    for (const a of world.agents) (a as any).key_hash = KEY_HASH
    const k = kit({ world })
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan], GOOD, k.deps)).toBe(0)
    const everything = [readFileSync(k.plan, 'utf8'), ...k.out, ...k.err].join('\n')
    expect(everything).not.toContain(CLERK_SECRET)
    expect(everything).not.toContain('sk_test_')
    expect(everything).not.toContain(KEY_HASH)
    expect(everything).not.toContain('key_hash')
  })

  it('an empty instance (no Clerk users, no vault rows) is a valid plan with empty lists', async () => {
    const k = kit({ world: { users: [], agents: [], memberships: [] }, clerk: [] })
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan], GOOD, k.deps)).toBe(0)
    const plan = JSON.parse(readFileSync(k.plan, 'utf8')) as AuthPlan
    expect(plan).toMatchObject({
      people: [],
      clerk_only: [],
      agents: [],
      snapshot: { clerk_users: [], users: [], agents: [], memberships: [] },
    })
  })
})

// group 5: read-only.
describe('read-only', () => {
  it('every wrangler command is a time-travel info or a remote d1 execute of one SELECT; no secret, deploy or migrations command; Clerk is only read', async () => {
    const k = kit()
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan], GOOD, k.deps)).toBe(0)
    expect(k.wrangler.cmds.length).toBe(5) // two bookmarks, three SELECTs
    for (const c of k.wrangler.cmds) {
      expect(c.command).toBe('pnpm')
      expect(c.args.slice(0, 3)).toEqual(['exec', 'wrangler', 'd1'])
      expect(c.args.some((a) => ['secret', 'deploy', 'migrations', 'delete', 'put'].includes(a))).toBe(false)
      if (c.args.includes('time-travel')) {
        expect(c.args[c.args.indexOf('time-travel') + 1]).toBe('info')
        expect(c.args).not.toContain('restore')
        continue
      }
      expect(c.args[3]).toBe('execute')
      expect(c.args).toContain('--remote')
      const sql = c.args[c.args.indexOf('--command') + 1]!
      expect(isReadOnlySql(sql)).toBe(true)
      expect(sql.replace(/;\s*$/, '')).not.toContain(';')
    }
    expect(k.clerk.calls.length).toBeGreaterThan(0)
    expect(k.clerk.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('--dry-run reads, prints a summary without personal data, and writes no file', async () => {
    const k = kit()
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan, '--dry-run'], GOOD, k.deps)).toBe(0)
    expect(existsSync(k.plan)).toBe(false)
    expect(readdirSync(k.dir)).toEqual([])
    const text = k.out.join('\n')
    expect(text).toMatch(/dry run/i)
    expect(text).toMatch(/5 people/)
    expect(text).toMatch(/8 agents/)
    expect(text).not.toContain('@example.test')
    expect(k.wrangler.cmds.length).toBe(5)
  })

  it('a real run prints where the plan went, and its counts', async () => {
    const k = kit()
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', k.plan], GOOD, k.deps)).toBe(0)
    expect(existsSync(k.plan)).toBe(true)
    expect(k.out.join('\n')).toContain(k.plan)
  })
})

// ---- [[OPS392]]: `apply` ----

/** The vault after the plan: what a fresh export shows once both batches have committed (users and agent accounts re-pointed, delegated agents disabled, the plan's memberships live). */
function afterWorld(world: World, plan: AuthPlan): World {
  const w = structuredClone(world)
  for (const p of plan.people.filter((x) => x.action === 'migrate')) {
    const u = w.users.find((x) => x.id === p.user_id)!
    u.auth_provider = 'better-auth'
    u.auth_subject = p.new_auth_user_id
    if (p.role !== null && p.membership === null)
      w.memberships.push({
        id: `0190ffff-0000-7000-8000-${String(w.memberships.length).padStart(12, '0')}`,
        user_id: p.user_id,
        role: p.role,
        deleted_at: null,
      })
  }
  for (const a of plan.agents) {
    const row = w.agents.find((x) => x.id === a.id)!
    if (a.action === 'relink') {
      row.auth_provider = 'better-auth'
      row.auth_subject = a.new_auth_user_id
    }
    if (a.action === 'disable') row.disabled_at = '2026-11-17T09:00:00.000Z'
  }
  return w
}

describe('auth:migrate:remote apply', () => {
  /** A plan written by the real plan command, then an apply kit over the given (possibly changed) instance. */
  async function planFile(over: { world?: World } = {}) {
    const p = kit()
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', p.plan], GOOD, p.deps)).toBe(0)
    const plan = JSON.parse(readFileSync(p.plan, 'utf8')) as AuthPlan
    return { p, plan, world: over.world ?? standardWorld() }
  }
  const applyArgv = (path: string, ...more: string[]) => ['apply', '--env', 'hq', '--plan', path, ...more]
  const noCalls = (k: ReturnType<typeof kit>) => {
    expect(k.wrangler.cmds).toEqual([])
    expect(k.clerk.calls).toEqual([])
  }
  const quiet = (k: ReturnType<typeof kit>) => {
    const everything = [...k.out, ...k.err].join('\n')
    expect(everything).not.toContain(CLERK_SECRET)
    expect(everything).not.toContain('sk_test_')
  }
  /** Rewrites the plan file with a change, for the plan file checks. */
  const edited = (plan: AuthPlan, f: (p: any) => void, path: string) => {
    const copy = structuredClone(plan) as any
    f(copy)
    writeFileSync(path, JSON.stringify(copy))
  }

  it('without --dry-run it refuses before any call and names #393 (the dormant real run, P1)', async () => {
    const { p } = await planFile()
    const k = kit()
    const code = await runAuthMigrate(applyArgv(p.plan), GOOD, k.deps)
    expect(code).toBe(1)
    expect(k.err.join('\n')).toMatch(/#393/)
    expect(k.err.join('\n')).toMatch(/provider switch is not built/)
    expect(k.calls).toEqual([]) // not even the credentials were loaded
    noCalls(k)
    quiet(k)
  })

  it('has the guards plan has: no CONFIRM_REMOTE=1, no --env, no --plan file named', async () => {
    const { p } = await planFile()
    for (const [argv, env, match] of [
      [applyArgv(p.plan, '--dry-run'), {}, /CONFIRM_REMOTE=1/],
      [['apply', '--plan', p.plan, '--dry-run'], GOOD, /--env/],
    ] as const) {
      const k = kit()
      expect(await runAuthMigrate([...argv], env, k.deps)).toBe(1)
      expect(k.err.join('\n')).toMatch(match)
      noCalls(k)
    }
  })

  const planChecks: Array<[string, (plan: AuthPlan, path: string) => void, RegExp]> = [
    ['a plan file that is missing', (_p, path) => rmSync(path), /missing|read/i],
    ['a plan file that is unreadable (a directory)', (_p, path) => (rmSync(path), mkdirSync(path)), /read/i],
    ['a plan file that is not JSON', (_p, path) => writeFileSync(path, 'not json'), /read|JSON/i],
    ['an unknown version', (p, path) => edited(p, (x) => (x.version = 2), path), /version/],
    ['a plan made for another env', (p, path) => edited(p, (x) => (x.env = 'hq-staging'), path), /env/],
    [
      'another CRM database name',
      (p, path) => edited(p, (x) => (x.crm.database_name = 'vault-crm-other'), path),
      /database/,
    ],
    ['another CRM database id', (p, path) => edited(p, (x) => (x.crm.database_id = 'other-id'), path), /database/],
    [
      'another control database name',
      (p, path) => edited(p, (x) => (x.control.database_name = 'other'), path),
      /database/,
    ],
    [
      'another control database id',
      (p, path) => edited(p, (x) => (x.control.database_id = 'other-id'), path),
      /database/,
    ],
  ]
  for (const [title, change, match] of planChecks) {
    it(`${title}: exit 1 before any wrangler or Clerk call`, async () => {
      const { p, plan } = await planFile()
      change(plan, p.plan)
      const k = kit()
      expect(await runAuthMigrate(applyArgv(p.plan, '--dry-run'), GOOD, k.deps)).toBe(1)
      expect(k.err.join('\n')).toMatch(match)
      noCalls(k)
      quiet(k)
    })
  }

  it('--dry-run on an instance that still matches the snapshot: not applied, counts per action, no personal data, only reads', async () => {
    const { p } = await planFile()
    const k = kit()
    expect(await runAuthMigrate(applyArgv(p.plan, '--dry-run'), GOOD, k.deps)).toBe(0)
    const text = k.out.join('\n')
    expect(text).toMatch(/not applied/i)
    expect(text).toMatch(/dry run/i)
    expect(text).toMatch(/auth_users rows \(3 people, 1 agent account\)/)
    expect(text).toMatch(/users re-pointed: 3/)
    expect(text).toMatch(/agents relinked: 1/)
    expect(text).toMatch(/agents disabled: 3/)
    expect(text).toMatch(/memberships inserted: 0/)
    expect(text).not.toContain('@example.test')
    // nothing but reads: no secret, deploy or migrations command, no write SQL, Clerk only read, no invitation
    for (const c of k.wrangler.cmds) {
      expect(c.args.some((a) => ['secret', 'deploy', 'migrations', 'delete', 'put', 'time-travel'].includes(a))).toBe(
        false,
      )
      expect(isReadOnlySql(c.args[c.args.indexOf('--command') + 1]!)).toBe(true)
    }
    expect(k.wrangler.cmds.length).toBe(3)
    expect(k.clerk.calls.length).toBeGreaterThan(0)
    expect(k.clerk.calls.every((c) => c.method === 'GET' && !/invitation/.test(c.url))).toBe(true)
    quiet(k)
  })

  it('--dry-run on an instance the plan is already applied to says so and exits 0', async () => {
    const { p, plan } = await planFile()
    const k = kit({ world: afterWorld(standardWorld(), plan) })
    expect(await runAuthMigrate(applyArgv(p.plan, '--dry-run'), GOOD, k.deps)).toBe(0)
    expect(k.out.join('\n')).toMatch(/already applied/i)
    expect(k.err).toEqual([])
    quiet(k)
  })

  it('--dry-run on an instance that changed since the plan: mismatch, exit 1, the differing rows named by id', async () => {
    const { p } = await planFile()
    const world = standardWorld()
    world.users[0]!.name = 'Changed'
    const k = kit({ world })
    expect(await runAuthMigrate(applyArgv(p.plan, '--dry-run'), GOOD, k.deps)).toBe(1)
    expect(k.err.join('\n')).toContain(world.users[0]!.id)
    expect(k.err.join('\n')).toMatch(/plan again/i)
    expect(k.wrangler.cmds.every((c) => isReadOnlySql(c.args[c.args.indexOf('--command') + 1]!))).toBe(true)
    quiet(k)
  })

  it('--dry-run on a changed Clerk user: mismatch naming the Clerk user', async () => {
    const { p } = await planFile()
    const clerk = standardClerk()
    clerk[0]!.public_metadata = { vibase_role: 'member' }
    const k = kit({ clerk })
    expect(await runAuthMigrate(applyArgv(p.plan, '--dry-run'), GOOD, k.deps)).toBe(1)
    expect(k.err.join('\n')).toContain('user_scrubbeda')
    quiet(k)
  })

  it('a plan whose live membership role differs from its person role is refused at dry run, naming the person', async () => {
    const world = standardWorld()
    world.memberships[0]!.role = 'member' // Clerk says owner
    const p = kit({ world })
    expect(await runAuthMigrate(['plan', '--env', 'hq', '--plan', p.plan], GOOD, p.deps)).toBe(0)
    const k = kit({ world })
    expect(await runAuthMigrate(applyArgv(p.plan, '--dry-run'), GOOD, k.deps)).toBe(1)
    expect(k.err.join('\n')).toContain(world.users[0]!.id)
  })
})
