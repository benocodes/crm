// [[OPS397]]: `auth:migrate:remote -- claim`: a reset link per migrated person and per relinked agent account (P2, P3), the caps of the disabled delegated agents (P4), the checks before any write (P5) and the partial states (P6).
// The instance is a vault seeded into a local D1 pair (Miniflare), the plan the real plan command would write, and a REAL apply (`applyBatches`); the links are judged by the real Worker composition that accepts them.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openControlDb, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { composeD1Worker } from '../src/compose.js'
import { AUTH_BASE } from '../src/test/auth-kit.js'
import { openWorkerPair, spyD1, type WorkerPair } from '../src/test/kit.js'
import { runAuthMigrate, type PlanDeps } from './auth-migrate-remote.js'
import { applyBatches } from './auth-migrate/apply.js'
import {
  CLERK_SECRET,
  ORG_ID,
  clerkRowsOf,
  fakeClerk,
  ids,
  planOf,
  readSnapshot,
  seedWorld,
  standardClerk,
  standardWorld,
  type World,
} from './auth-migrate/test-kit.js'
import type { AuthPlan } from './auth-migrate/types.js'

const { U, A } = ids
const CRM_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CTL_ID = '9f8e7d6c-5b4a-4398-8765-4321fedcba98'
const SECRET = 'an-auth-secret-that-is-long-enough-0123456789abcdef'
const BASE = AUTH_BASE
const GOOD = { CONFIRM_REMOTE: '1' }
const WRITE = /^\s*(insert|update|delete|replace)\b/i
const VARS = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE }
const config = (vars: Record<string, unknown> = VARS, control = true) => ({
  name: 'vault-hq',
  d1_databases: [
    { binding: 'DB', database_name: 'vault-crm-hq', database_id: CRM_ID, remote: true },
    ...(control ? [{ binding: 'CONTROL_DB', database_name: 'vault-control-hq', database_id: CTL_ID, remote: true }] : []),
  ],
  vars,
})
const envText = (secret: string | null = SECRET) =>
  `CLERK_SECRET_KEY=${CLERK_SECRET}\n${secret === null ? '' : `AUTH_SECRET=${secret}\n`}`
const NEW_PASSWORD = 'a brand new password 456'

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
const dirs: string[] = []
afterEach(async () => {
  await pair.reset()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})
let consoleLines: string[] = []
beforeEach(() => {
  consoleLines = []
  for (const m of ['error', 'warn', 'log', 'info', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(' ')))
})
const rows = async (d1: D1Like, q: string, ...b: unknown[]) =>
  ((
    await d1
      .prepare(q)
      .bind(...b)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const CRM_TABLES = ['principals', 'users', 'agents', 'memberships', 'events', 'organizations', 'deployment']
const crmDump = async () =>
  JSON.stringify(await Promise.all(CRM_TABLES.map(async (t) => [t, await rows(pair.d1, `select * from ${t} order by 1`)])))
const audits = () =>
  rows(pair.control, "select actor_id, target_id, detail from control_audit where action = 'user.reset_link_issued' order by at, id")
const verifications = () => rows(pair.control, "select identifier from auth_verifications where identifier like 'reset-password:%'")
const URL_RE = /https?:\/\/\S+#token=([A-Za-z0-9_-]+)/g
const urlsIn = (lines: string[]) => [...lines.join('\n').matchAll(URL_RE)].map((m) => ({ url: m[0], token: m[1]! }))

interface Ctx {
  dir: string
  planPath: string
  plan: AuthPlan
  envFile: string
  bodies: Array<Record<string, any>>
}
/** The vault, applied by the real apply batches (or not: `apply: false`), the plan file and the instance's own env file. */
async function setup(o: { world?: World; apply?: boolean; envText?: string; unpaired?: boolean } = {}): Promise<Ctx> {
  const world = o.world ?? standardWorld()
  const bodies = standardClerk()
  await seedWorld(pair.d1, world)
  if (!o.unpaired) await writeControlMarker(openControlDb(pair.control), ORG_ID)
  const snapshot = await readSnapshot(pair.d1, await clerkRowsOf(bodies))
  const plan = planOf(snapshot)
  plan.crm = { database_name: 'vault-crm-hq', database_id: CRM_ID, bookmark: 'B1' }
  plan.control = { database_name: 'vault-control-hq', database_id: CTL_ID, bookmark: 'B2' }
  if (o.apply !== false) {
    let n = 0
    await applyBatches({
      plan,
      fresh: snapshot,
      crm: pair.d1,
      control: pair.control,
      now: () => new Date('2026-11-17T09:00:00.000Z'),
      newId: () => `0190eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    })
  }
  const dir = mkdtempSync(join(tmpdir(), 'auth-claim-'))
  dirs.push(dir)
  const planPath = join(dir, 'hq.auth-plan.json')
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 })
  const envFile = join(dir, '.env.hq')
  writeFileSync(envFile, o.envText ?? envText())
  chmodSync(envFile, 0o600)
  return { dir, planPath, plan, envFile, bodies }
}

let idCounter = 0 // ids stay unique across runs, as uuidv7 does
interface RunOpts {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  cfg?: ReturnType<typeof config>
  control?: (d1: D1Like) => D1Like
  /** the plan file to pass (default: the one `setup` wrote) */
  planPath?: string
}
/** One run of `claim`: its exit code, what it printed (stdout lines in `out`, stderr in `err`) and every write it made. */
async function runClaim(c: Ctx, o: RunOpts = {}) {
  const crmSpy = spyD1(pair.d1)
  const ctlSpy = spyD1(pair.control)
  const out: string[] = []
  const err: string[] = []
  const cmds: unknown[] = []
  let opened = 0
  const clerk = fakeClerk(c.bodies, 500)
  const deps: PlanDeps = {
    loadEnv: () => {},
    readConfig: () => o.cfg ?? config(),
    readInstanceEnv: () => ({ display: '.env.hq', status: 'ok', text: readFileSync(c.envFile, 'utf8') }),
    exec: (cmd) => {
      cmds.push(cmd)
      throw new Error('claim runs no wrangler command')
    },
    fetch: clerk.fetch,
    exists: () => false,
    repoPathNotIgnored: () => false,
    readText: (p) => readFileSync(p, 'utf8'),
    writeNew: () => {
      throw new Error('claim writes no file')
    },
    withDatabases: async (_env, fn) => {
      opened++
      return fn({ crm: crmSpy.d1, control: o.control ? o.control(ctlSpy.d1) : ctlSpy.d1 })
    },
    run: (cmd) => {
      cmds.push(cmd)
      throw new Error('claim runs no command')
    },
    git: () => ({ status: 0, stdout: '' }),
    appendEnvVar: () => {
      throw new Error('claim writes no env file')
    },
    deploy: () => {
      throw new Error('claim deploys nothing')
    },
    now: () => new Date('2026-11-17T10:00:00.000Z'),
    newId: () => `0190ffff-0000-7000-8000-${String(++idCounter).padStart(12, '0')}`,
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  }
  const code = await runAuthMigrate(
    ['claim', '--env', 'hq', '--plan', o.planPath ?? c.planPath, ...(o.argv ?? [])],
    o.env ?? GOOD,
    deps,
  )
  const writes = (s: { log: { statements: string[] } }) => s.log.statements.filter((q) => WRITE.test(q))
  return {
    code,
    out,
    err,
    cmds,
    opened: () => opened,
    crmWrites: () => writes(crmSpy).length,
    controlWrites: () => writes(ctlSpy),
    text: () => [...out, ...err].join('\n'),
  }
}
/** The addresses a plan gives a link: migrate people and relink agent accounts, in the plan's order (people first). */
const targetEmails = (c: Ctx) => {
  const clerk = new Map(c.plan.snapshot.clerk_users.map((u) => [u.id, u]))
  return [
    ...c.plan.people.filter((p) => p.action === 'migrate').map((p) => p.email),
    ...c.plan.agents
      .filter((a) => a.action === 'relink')
      .map((a) => clerk.get(c.plan.snapshot.agents.find((x) => x.id === a.id)!.auth_subject!)!.email!.toLowerCase()),
  ]
}
const subjectOf = async (email: string) => (await rows(pair.control, 'select id from auth_users where email = ?', email))[0]!.id as string
const worker = () =>
  composeD1Worker({ DB: pair.d1, CONTROL_DB: pair.control, AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE })
let ip = 0
const post = (path: string, body: unknown) =>
  worker().fetch(
    new Request(BASE + path, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++ip}` },
      body: JSON.stringify(body),
    }),
  )
const setPassword = (token: string) => post('/auth/reset-password', { token, newPassword: NEW_PASSWORD })

// ---- the matrix: target state x run ----

describe('targets and links (P2, P3)', () => {
  it('a full run issues one link per migrated person and per relinked agent account, each with one audit row, and nobody else', async () => {
    const c = await setup()
    const crm = await crmDump()
    const targets = targetEmails(c)
    // a owner, b member, d (Clerk holds no role) are people to migrate; c is the one relinked agent account (f's Clerk user is a member, so its agent is disabled)
    expect(targets).toEqual(['a@example.test', 'b@example.test', 'd@example.test', 'c@example.test'])
    const r = await runClaim(c)
    expect(r.code, r.text()).toBe(0)
    const links = urlsIn(r.out)
    expect(links).toHaveLength(targets.length)
    expect(new Set(links.map((l) => l.token)).size).toBe(targets.length)
    for (const t of targets) expect(r.out.filter((l) => l.includes(t) && l.includes('#token='))).toHaveLength(1)
    const log = await audits()
    expect(log).toHaveLength(targets.length)
    const system = ((await rows(pair.d1, "select id from principals where kind = 'system'"))[0] as any).id
    expect(log.map((a) => a.actor_id)).toEqual(Array(targets.length).fill(system))
    expect(new Set(log.map((a) => a.target_id))).toEqual(new Set(await Promise.all(targets.map(subjectOf))))
    for (const a of log) expect(JSON.parse(a.detail).via).toBe('auth-migrate-claim')
    expect(await crmDump()).toBe(crm)
    expect(r.crmWrites()).toBe(0)
    expect(r.cmds).toEqual([])
    expect(r.out.join('\n')).not.toMatch(/nolink@|gone@/)
    expect(r.out.join('\n')).not.toMatch(/0190aaaa-0000-7000-8000-00000000000[45]/)
  })

  it('a link is a real Better Auth reset link: it sets the password of the apply-made account once', async () => {
    const c = await setup()
    const r = await runClaim(c)
    const first = urlsIn(r.out)[0]!
    expect(new URL(first.url).origin).toBe(BASE)
    expect(new URL(first.url).pathname).toBe('/reset-password')
    expect((await setPassword(first.token)).status).toBe(200)
    expect((await setPassword(first.token)).status).toBe(400)
  })

  it('a claimed target (it has an account row) is listed as claimed and gets no link; a re-run issues fresh links to the unclaimed only, and earlier unused links stay valid', async () => {
    const c = await setup()
    const targets = targetEmails(c)
    const first = await runClaim(c)
    // claim the owner: the link on the line naming a@example.test
    const ownerLine = first.out.find((l) => l.includes('a@example.test') && l.includes('#token='))!
    const ownerToken = ownerLine.match(/#token=([A-Za-z0-9_-]+)/)![1]!
    expect((await setPassword(ownerToken)).status).toBe(200)
    const again = await runClaim(c)
    expect(again.code, again.text()).toBe(0)
    expect(urlsIn(again.out)).toHaveLength(targets.length - 1)
    expect(again.out.filter((l) => /claimed/i.test(l) && l.includes('a@example.test') && !l.includes('#token='))).toHaveLength(1)
    expect(again.out.filter((l) => l.includes('a@example.test') && l.includes('#token='))).toEqual([])
    expect(await audits()).toHaveLength(targets.length + targets.length - 1)
    // an earlier unused link (member b's, first run) still works
    const bLine = first.out.find((l) => l.includes('b@example.test') && l.includes('#token='))!
    expect((await setPassword(bLine.match(/#token=([A-Za-z0-9_-]+)/)![1]!)).status).toBe(200)
  })

  it('--email limits the run to one target of each kind: a person, and an agent account', async () => {
    const c = await setup()
    for (const [email, who] of [
      ['d@example.test', 'person'],
      ['c@example.test', 'agent account'],
    ] as const) {
      const before = (await audits()).length
      const r = await runClaim(c, { argv: ['--email', email.toUpperCase()] })
      expect(r.code, `${who}: ${r.text()}`).toBe(0)
      expect(urlsIn(r.out)).toHaveLength(1)
      expect((await audits()).length).toBe(before + 1)
      expect(r.out.filter((l) => l.includes('#token=')).join('\n')).toContain(email)
    }
  })

  it('--email on an address that is not a target, or on a claimed target, is refused with nothing written', async () => {
    const c = await setup()
    const first = await runClaim(c, { argv: ['--email', 'a@example.test'] })
    expect((await setPassword(urlsIn(first.out)[0]!.token)).status).toBe(200)
    const crm = await crmDump()
    const before = { audits: (await audits()).length, verifs: (await verifications()).length }
    for (const [email, phrase] of [
      ['nolink@example.test', /is not a claim target/],
      ['gone@example.test', /is not a claim target/],
      ['nobody@example.test', /is not a claim target/],
      ['a@example.test', /already claimed.*users\.issue_reset_link.*owner-reset/s],
      ['not an address', /is not a valid address/],
    ] as const) {
      const r = await runClaim(c, { argv: ['--email', email] })
      expect([email, r.code, r.err.join('\n')]).toEqual([email, 1, expect.stringMatching(phrase)])
      expect(urlsIn(r.out)).toEqual([])
      expect(r.controlWrites()).toEqual([])
    }
    expect(await crmDump()).toBe(crm)
    expect({ audits: (await audits()).length, verifs: (await verifications()).length }).toEqual(before)
  })

  it('a plan with no targets exits 0, writes nothing and still prints the caps', async () => {
    const world = standardWorld()
    world.users = [world.users[4]!]
    world.memberships = []
    world.agents = world.agents.filter((a) => ['plain key', 'delegated'].includes(a.name)).map((a) => (a.delegated_by ? { ...a, delegated_by: U(5) } : a))
    const c = await setup({ world })
    expect(targetEmails(c)).toEqual([])
    const r = await runClaim(c)
    expect(r.code, r.text()).toBe(0)
    expect(urlsIn(r.out)).toEqual([])
    expect(r.out.join('\n')).toMatch(/nothing to issue/)
    expect(r.out.join('\n')).toContain(A(3))
    expect(r.controlWrites()).toEqual([])
    expect(await audits()).toEqual([])
  })

  it('a run where every target is claimed exits 0 with nothing to issue', async () => {
    const d = await setup()
    for (const l of urlsIn((await runClaim(d)).out)) expect((await setPassword(l.token)).status).toBe(200)
    const done = await runClaim(d)
    expect(done.code, done.text()).toBe(0)
    expect(urlsIn(done.out)).toEqual([])
    expect(done.out.join('\n')).toMatch(/nothing to issue/)
  })

  it('--dry-run lists who would get a link and issues nothing: no verification row, no audit row, no URL', async () => {
    const c = await setup()
    const crm = await crmDump()
    const r = await runClaim(c, { argv: ['--dry-run'] })
    expect(r.code, r.text()).toBe(0)
    expect(r.out.join('\n')).toMatch(/dry run: would issue a link for a@example\.test/)
    expect(urlsIn(r.out)).toEqual([])
    expect(r.controlWrites()).toEqual([])
    expect(await verifications()).toEqual([])
    expect(await audits()).toEqual([])
    expect(await crmDump()).toBe(crm)
  })
})

// ---- P4 ----

describe('the caps print (P4)', () => {
  it("each disabled delegated agent's id, name and scopes come from the plan in its order, dry run too; a kept (already disabled) one is absent", async () => {
    const world = standardWorld()
    world.agents.push({
      ...world.agents[2]!,
      id: A(9),
      name: 'second delegated',
      auth_client_id: 'client_z',
      scopes: ['tasks:write', 'contacts:read', 'notes:write'],
    })
    const c = await setup({ world })
    for (const argv of [[], ['--dry-run']]) {
      const r = await runClaim(c, { argv })
      const text = r.out.join('\n')
      const caps = r.out.filter((l) => /caps/.test(l))
      expect(caps).toHaveLength(2)
      expect(caps[0]).toContain(A(3))
      expect(caps[0]).toContain('"delegated"')
      expect(caps[0]).toContain('contacts:read, notes:write')
      expect(caps[1]).toContain(A(9))
      expect(caps[1]).toContain('tasks:write, contacts:read, notes:write')
      expect(caps[0]).toMatch(/reconnect the client and grant these scopes to the new delegated agent/)
      expect(text).not.toContain(A(6)) // already disabled: action keep
      expect(text).not.toContain(A(7)) // an agent account with no Clerk user: disabled, but not delegated
    }
  })
})

// ---- P5 ----

/** One migrated owner with a live membership and no agents: apply writes no event, so no system principal exists. */
function onlyPerson(): World {
  const w = standardWorld()
  return { users: [w.users[0]!], memberships: [w.memberships[0]!], agents: [] }
}

describe('refused before any write (P5)', () => {
  const cases: Array<[string, (c: Ctx) => Promise<RunOpts | undefined> | RunOpts | undefined, RegExp, { apply?: boolean; world?: World }?]> = [
    ['the instance is not applied', () => undefined, /claim needs an applied instance.*apply/s, { apply: false }],
    [
      'the instance no longer matches the plan',
      async () => {
        await pair.d1.prepare("update users set name = 'Renamed' where id = ?").bind(U(2)).run()
        return undefined
      },
      /claim needs an applied instance.*no longer matches the plan.*users row/s,
    ],
    ['the record is not better-auth', () => ({ cfg: config({ AUTH_PROVIDER: 'clerk', PUBLIC_BASE_URL: BASE }) }), /claim needs a better-auth instance/],
    ['the record binds no control database', () => ({ cfg: config(VARS, false) }), /claim needs a control database/],
    ['the record has no PUBLIC_BASE_URL', () => ({ cfg: config({ AUTH_PROVIDER: 'better-auth' }) }), /claim needs PUBLIC_BASE_URL/],
    [
      'AUTH_SECRET is missing from the instance file',
      (c) => void writeFileSync(c.envFile, envText(null)),
      /claim needs AUTH_SECRET in \.env\.hq/,
    ],
    [
      'AUTH_SECRET is short',
      (c) => void writeFileSync(c.envFile, envText('short-secret')),
      /AUTH_SECRET in \.env\.hq is shorter than 32 characters.*not the value the Worker holds/s,
    ],
    [
      // apply mints the system principal only when it writes an event: a plan that changes no agent and inserts no membership leaves none
      'the CRM database has no system principal',
      () => undefined,
      /claim needs the organisation's system principal/,
      { world: onlyPerson() },
    ],
  ]
  for (const [name, arrange, phrase, opt] of cases)
    for (const dry of [false, true])
      it(`${name}: exit 1, nothing written${dry ? ' (--dry-run)' : ''}`, async () => {
        const c = await setup(opt)
        const o = (await arrange(c)) ?? {}
        const crm = await crmDump()
        const before = { audits: await audits(), verifs: await verifications(), users: await rows(pair.control, 'select * from auth_users') }
        const r = await runClaim(c, { ...o, argv: dry ? ['--dry-run'] : [] })
        expect(r.code, r.text()).toBe(1)
        expect(r.err.join('\n')).toMatch(phrase)
        expect(urlsIn(r.out)).toEqual([])
        expect(r.controlWrites()).toEqual([])
        expect(r.crmWrites()).toBe(0)
        expect({ audits: await audits(), verifs: await verifications(), users: await rows(pair.control, 'select * from auth_users') }).toEqual(before)
        expect(await crmDump()).toBe(crm)
      })

  it('the inherited guards: no CONFIRM_REMOTE, no --env, a missing plan file, a plan made for another env', async () => {
    const c = await setup()
    const crm = await crmDump()
    const run = (argv: string[], env: NodeJS.ProcessEnv = GOOD, planPath = c.planPath) =>
      runClaimRaw(c, argv, env, planPath)
    expect((await runClaim(c, { env: {} })).err.join('\n')).toMatch(/set CONFIRM_REMOTE=1/)
    expect((await run(['claim'])).err.join('\n')).toMatch(/--env <name> is required/)
    expect((await runClaim(c, { planPath: join(c.dir, 'missing.json') })).err.join('\n')).toMatch(/plan file .* is missing or unreadable/)
    const other = join(c.dir, 'other.json')
    writeFileSync(other, JSON.stringify({ ...c.plan, env: 'smoked1' }))
    expect((await runClaim(c, { planPath: other })).err.join('\n')).toMatch(/made for env smoked1, not hq/)
    expect(await audits()).toEqual([])
    expect(await crmDump()).toBe(crm)
  })
})
async function runClaimRaw(c: Ctx, argv: string[], env: NodeJS.ProcessEnv, _planPath: string) {
  const err: string[] = []
  const code = await runAuthMigrate(argv, env, {
    ...(await depsStub(c)),
    error: (l: string) => void err.push(l),
  } as PlanDeps)
  return { code, err }
}
async function depsStub(c: Ctx): Promise<Partial<PlanDeps>> {
  return {
    loadEnv: () => {},
    readConfig: () => config(),
    readInstanceEnv: () => ({ display: '.env.hq', status: 'ok', text: readFileSync(c.envFile, 'utf8') }),
    readText: (p) => readFileSync(p, 'utf8'),
    log: () => {},
  }
}

// ---- P6 ----

/** A control D1 whose `nth` statement matching `match` throws (a failing store). */
function failingNth(real: D1Like, match: RegExp, nth: number): D1Like {
  let seen = 0
  return {
    prepare(q: string) {
      const p = real.prepare(q)
      if (!match.test(q) || ++seen !== nth) return p
      const boom = async () => {
        throw new Error('D1 write failed')
      }
      return { bind: () => ({ run: boom, all: boom, first: boom }), run: boom, all: boom, first: boom } as any
    },
    batch: (s) => real.batch(s),
  }
}

describe('partial failure and re-run (P6)', () => {
  it("a token that fails on target 2 exits 2: target 1's link is printed with its audit row, nothing for 2, and the message names who got one and who did not; a re-run issues the rest", async () => {
    const c = await setup()
    const targets = targetEmails(c)
    const r = await runClaim(c, { control: (d1) => failingNth(d1, /insert into "auth_verifications"/, 2) })
    expect(r.code).toBe(2)
    const links = urlsIn(r.out)
    expect(links).toHaveLength(1)
    expect(r.out.filter((l) => l.includes('#token=')).join('\n')).toContain(targets[0]!)
    expect(await audits()).toHaveLength(1)
    const msg = r.err.join('\n')
    expect(msg).toMatch(/claim failed for/)
    expect(msg).toContain(targets[1]!)
    expect(msg).toMatch(new RegExp(`links were issued for: ${targets[0]!.replace('.', '\\.')}\\b`))
    expect(msg).toMatch(/not issued: .*run claim again/s)
    // the one printed link is still good after the re-run
    const again = await runClaim(c)
    expect(again.code, again.text()).toBe(0)
    expect(urlsIn(again.out)).toHaveLength(targets.length)
    expect((await setPassword(links[0]!.token)).status).toBe(200)
  })

  it('an audit row that fails on target 2 exits 2 and prints no link for 2 (its unused verification row expires); target 1 keeps its link and audit row', async () => {
    const c = await setup()
    const targets = targetEmails(c)
    const r = await runClaim(c, { control: (d1) => failingNth(d1, /user\.reset_link_issued/, 2) })
    expect(r.code).toBe(2)
    expect(urlsIn(r.out)).toHaveLength(1)
    expect(await audits()).toHaveLength(1)
    const issuedTokens = (await verifications()).map((v) => v.identifier.replace('reset-password:', ''))
    expect(issuedTokens).toHaveLength(2) // 1 printed, 1 issued but never printed
    const unprinted = issuedTokens.filter((t) => t !== urlsIn(r.out)[0]!.token)
    expect(unprinted).toHaveLength(1)
    expect(r.text()).not.toContain(unprinted[0]!)
    expect(r.err.join('\n')).toMatch(/not recorded in the audit log/)
    expect(r.err.join('\n')).toContain(targets[1]!)
    const subjects = (await audits()).map((a) => a.target_id)
    expect(subjects).toEqual([await subjectOf(targets[0]!)])
  })
})

// ---- no secret leaks ----

describe('no secret leaks', () => {
  it('AUTH_SECRET, CLERK_SECRET_KEY and every token appear only where allowed: the one printed URL per target on stdout; no command, no file, no stderr', async () => {
    const c = await setup()
    const filesBefore = readdirSync(c.dir).sort()
    const r = await runClaim(c)
    expect(r.code).toBe(0)
    const links = urlsIn(r.out)
    expect(links.length).toBeGreaterThan(0)
    const everything = [...r.out, ...r.err, ...consoleLines, ...r.cmds.map(String)].join('\n')
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain(CLERK_SECRET)
    for (const l of links) {
      expect(r.err.join('\n')).not.toContain(l.token)
      expect(consoleLines.join('\n')).not.toContain(l.token)
      expect(r.out.filter((x) => x.includes(l.token))).toHaveLength(1)
    }
    expect(r.cmds).toEqual([])
    expect(readdirSync(c.dir).sort()).toEqual(filesBefore)
    // the same run's failure and refusal messages carry no secret either
    const bad = await runClaim(c, { argv: ['--email', 'nobody@example.test'] })
    const failed = await runClaim(c, { control: (d1) => failingNth(d1, /user\.reset_link_issued/, 1) })
    for (const t of [bad.text(), failed.text()]) {
      expect(t).not.toContain(SECRET)
      expect(t).not.toContain(CLERK_SECRET)
    }
    for (const t of urlsIn(failed.out)) expect(failed.err.join('\n')).not.toContain(t.token)
  })
})
