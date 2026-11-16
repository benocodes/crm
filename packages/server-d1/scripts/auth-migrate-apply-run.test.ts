// [[OPS393]]: `auth:migrate:remote -- apply` as a real run: the checks before any write, the order control batch, secret, deploy, CRM batch, `AUTH_SECRET`, the stopping points and re-runs, the exit codes and the D14 marker.
// The two databases are local D1s (Miniflare's real D1 and SQLite semantics) behind the same handles the real run opens remotely; wrangler's secret put and the deploy are faked at the command boundary, as `plan` and `deploy:remote` are.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CONTROL_MIGRATIONS, MIGRATIONS, openControlDb, writeControlMarker, type D1Like } from '@vibase/storage-d1'
import { faultD1, openWorkerPair, spyD1, type WorkerPair } from '../src/test/kit.js'
import { appendInstanceVar, runAuthMigrate, type PlanDeps } from './auth-migrate-remote.js'
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
import { RemoteRefusal, type Cmd } from './remote.js'

const { U, A } = ids
const CRM_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CTL_ID = '9f8e7d6c-5b4a-4398-8765-4321fedcba98'
const GOOD = { CONFIRM_REMOTE: '1' }
const WRITE = /^\s*(insert|update|delete|replace)\b/i
const BETTER_AUTH = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: 'https://api.hq.vibase.ai' }
const config = (vars: Record<string, unknown> = BETTER_AUTH) => ({
  name: 'vault-hq',
  d1_databases: [
    { binding: 'DB', database_name: 'vault-crm-hq', database_id: CRM_ID, remote: true },
    { binding: 'CONTROL_DB', database_name: 'vault-control-hq', database_id: CTL_ID, remote: true },
  ],
  vars,
})
const ENV_TEXT = `CLERK_SECRET_KEY=${CLERK_SECRET}\nOTHER=x\n`
const VALID_SECRET = 'an-auth-secret-that-is-long-enough-0123456789abcdef'

let pair: WorkerPair
const rows = async (d1: D1Like, q: string, ...b: unknown[]) =>
  ((
    await d1
      .prepare(q)
      .bind(...b)
      .all()
  ).results ?? []) as Array<Record<string, any>>
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
})
/** wrangler's tracker, as a deployed database has it (the local test databases are migrated without one). */
async function track(d1: D1Like, names: string[]) {
  await d1
    .prepare(
      'create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at timestamp not null default current_timestamp)',
    )
    .run()
  await d1.prepare('delete from d1_migrations').run()
  for (const name of names) await d1.prepare('insert into d1_migrations (name) values (?)').bind(name).run()
}

const TABLES = ['principals', 'users', 'agents', 'memberships', 'events', 'organizations', 'deployment']
async function crmDump(): Promise<string> {
  return JSON.stringify(
    await Promise.all(TABLES.map(async (t) => [t, await rows(pair.d1, `select * from ${t} order by 1`)])),
  )
}
const authUsers = () => rows(pair.control, 'select id, email from auth_users order by id')
const controlDump = async () =>
  JSON.stringify([await authUsers(), await rows(pair.control, 'select * from control_deployment')])

interface Ctx {
  dir: string
  planPath: string
  envFile: string
  plan: AuthPlan
  clerk: ReturnType<typeof fakeClerk>
}
/** The vault seeded into the CRM database, the control database paired with it, the plan the real plan command would write, and the instance's own env file. */
async function setup(
  o: { world?: World; bodies?: Array<Record<string, any>>; envText?: string; pair?: boolean } = {},
): Promise<Ctx> {
  const world = o.world ?? standardWorld()
  const bodies = o.bodies ?? standardClerk()
  await seedWorld(pair.d1, world)
  await track(
    pair.d1,
    MIGRATIONS.map((m) => m.name),
  )
  await track(
    pair.control,
    CONTROL_MIGRATIONS.map((m) => m.name),
  )
  if (o.pair !== false) await writeControlMarker(openControlDb(pair.control), ORG_ID)
  const snapshot = await readSnapshot(pair.d1, await clerkRowsOf(bodies))
  const plan = planOf(snapshot)
  plan.crm = { database_name: 'vault-crm-hq', database_id: CRM_ID, bookmark: 'B1' }
  plan.control = { database_name: 'vault-control-hq', database_id: CTL_ID, bookmark: 'B2' }
  const dir = mkdtempSync(join(tmpdir(), 'auth-apply-'))
  dirs.push(dir)
  const planPath = join(dir, 'hq.auth-plan.json')
  writeFileSync(planPath, JSON.stringify(plan))
  const envFile = join(dir, '.env.hq')
  writeFileSync(envFile, o.envText ?? ENV_TEXT, { mode: 0o644 })
  chmodSync(envFile, 0o644)
  return { dir, planPath, envFile, plan, clerk: fakeClerk(bodies, 500) }
}

interface Mark {
  kind: 'secret' | 'deploy'
  controlWrites: number
  crmWrites: number
}
interface RunOpts {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  cfg?: ReturnType<typeof config>
  /** wraps the CRM / control handle (a fault) */
  crm?: (d1: D1Like) => D1Like
  control?: (d1: D1Like) => D1Like
  putStatus?: number
  /** `git status --porcelain` output; non-empty is a dirty tree */
  dirty?: string
  deployThrows?: Error
  appendThrows?: Error
  deployStatus?: number
}
/** One run of the command: its exit code and everything it did at the boundaries. */
async function runApply(c: Ctx, o: RunOpts = {}) {
  const crmSpy = spyD1(pair.d1)
  const ctlSpy = spyD1(pair.control)
  const marks: Mark[] = []
  const cmds: Array<{ cmd: Cmd; input: string | undefined }> = []
  const out: string[] = []
  const err: string[] = []
  const events: string[] = []
  let opened = 0
  let appended = 0
  const writes = (s: { log: { statements: string[] } }) => s.log.statements.filter((q) => WRITE.test(q)).length
  const mark = (kind: Mark['kind']) => marks.push({ kind, controlWrites: writes(ctlSpy), crmWrites: writes(crmSpy) })
  const deps: PlanDeps = {
    loadEnv: () => void events.push('loadEnv'),
    readConfig: () => o.cfg ?? config(),
    readInstanceEnv: () => ({ display: '.env.hq', status: 'ok', text: readFileSync(c.envFile, 'utf8') }),
    exec: () => {
      throw new Error('apply reads through the opened handles, not through wrangler')
    },
    fetch: c.clerk.fetch,
    exists: () => false,
    repoPathNotIgnored: () => false,
    readText: (p) => readFileSync(p, 'utf8'),
    writeNew: () => {
      throw new Error('apply writes no plan file')
    },
    withDatabases: async (_env, fn) => {
      opened++
      return fn({ crm: o.crm ? o.crm(crmSpy.d1) : crmSpy.d1, control: o.control ? o.control(ctlSpy.d1) : ctlSpy.d1 })
    },
    run: (cmd, input) => {
      cmds.push({ cmd, input })
      mark('secret')
      return o.putStatus ?? 0
    },
    git: (args) => ({ status: 0, stdout: args[0] === 'status' ? (o.dirty ?? '') : 'abc123\n' }),
    appendEnvVar: (env, name, value) => {
      appended++
      if (o.appendThrows) throw o.appendThrows
      appendInstanceVar(c.envFile, env, name, value, c.dir, join(c.dir, 'root.env'))
    },
    deploy: () => {
      mark('deploy')
      if (o.deployThrows) throw o.deployThrows
      return o.deployStatus ?? 0
    },
    now: () => new Date('2026-11-17T09:00:00.000Z'),
    newId: (() => {
      let n = 0
      return () => `0190eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`
    })(),
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  }
  const code = await runAuthMigrate(
    ['apply', '--env', 'hq', '--plan', c.planPath, ...(o.argv ?? [])],
    o.env ?? GOOD,
    deps,
  )
  return {
    code,
    out,
    err,
    marks,
    cmds,
    events,
    opened: () => opened,
    appended: () => appended,
    crmWrites: () => writes(crmSpy),
    controlWrites: () => writes(ctlSpy),
    everything: () => [...out, ...err, ...cmds.flatMap((x) => [x.cmd.command, ...x.cmd.args])].join('\n'),
  }
}
const faultCrm = (
  match: RegExp,
  act: () => Promise<void> = async () => {
    throw new Error('D1 unavailable')
  },
) => {
  const f: { fault?: ReturnType<typeof faultD1> } = {}
  return { f, wrap: (d1: D1Like) => (f.fault = faultD1(d1, { match, act })).d1 }
}

// ---- group 1: refused before any write, exit 1 ([[OPS393]] P2, P3) ----

describe('apply refuses before any write', () => {
  const cases: Array<
    [string, (c: Ctx) => Promise<RunOpts | undefined> | RunOpts | undefined, RegExp, { unpaired?: boolean }?]
  > = [
    [
      'the env block still has clerk (the provider switch is not committed)',
      () => ({ cfg: config({ AUTH_PROVIDER: 'clerk' }) }),
      /provider switch is not committed/,
    ],
    [
      'the env block says better-auth but is not a Better Auth config (no PUBLIC_BASE_URL)',
      () => ({ cfg: config({ AUTH_PROVIDER: 'better-auth' }) }),
      /does not parse as a Better Auth config/,
    ],
    [
      'the CRM database has a pending migration',
      async () => {
        await pair.d1.prepare('delete from d1_migrations where name = ?').bind(MIGRATIONS.at(-1)!.name).run()
      },
      /CRM database has pending migrations.*db:migrate:remote/,
    ],
    [
      'the control database has a pending migration',
      async () => {
        await pair.control
          .prepare('delete from d1_migrations where name = ?')
          .bind(CONTROL_MIGRATIONS.at(-1)!.name)
          .run()
      },
      /control database has pending migrations.*db:migrate:remote/,
    ],
    [
      'the control database is not paired with the CRM organisation',
      () => undefined,
      /not paired with this CRM's organisation.*setup:remote/,
      { unpaired: true },
    ],
    [
      'the instance file holds an AUTH_SECRET the Worker would refuse',
      (c) => void writeFileSync(c.envFile, `${ENV_TEXT}AUTH_SECRET=short\n`),
      /AUTH_SECRET in \.env\.hq is shorter than 32/,
    ],
    [
      'the instance changed since the plan (the plan checks and the state check)',
      async () => void (await pair.d1.prepare("update users set name = 'Changed' where id = ?").bind(U(1)).run()),
      /no longer matches the plan/,
    ],
    [
      'the git tree is not clean (the provider switch is not committed)',
      () => ({ dirty: ' M packages/server-d1/wrangler.jsonc\n' }),
      /commit the provider switch/,
    ],
    ['a plan file that is missing', (c) => void rmSync(c.planPath), /missing or unreadable/],
  ]
  for (const dry of [false, true]) {
    for (const [title, change, match, opts] of cases) {
      it(`${dry ? '--dry-run: ' : ''}${title}: exit 1, the message, nothing written, no secret, no deploy`, async () => {
        const c = await setup({ pair: !opts?.unpaired })
        const run = (await change(c)) ?? {}
        const crmBefore = await crmDump()
        const ctlBefore = await controlDump()
        const envBefore = readFileSync(c.envFile, 'utf8')
        const r = await runApply(c, { ...run, argv: dry ? ['--dry-run'] : [] })
        expect(r.code).toBe(1)
        expect(r.err.join('\n')).toMatch(match)
        expect(r.err.join('\n')).not.toMatch(/not available yet|provider switch is not built|#393/)
        expect(r.crmWrites() + r.controlWrites()).toBe(0)
        expect(r.cmds).toEqual([])
        expect(r.marks).toEqual([])
        expect(r.appended()).toBe(0)
        expect(await crmDump()).toBe(crmBefore)
        expect(await controlDump()).toBe(ctlBefore)
        expect(readFileSync(c.envFile, 'utf8')).toBe(envBefore)
      })
    }
  }

  it('the inherited guards: no CONFIRM_REMOTE=1 and no --env refuse before the databases are opened', async () => {
    const c = await setup()
    const a = await runApply(c, { env: {} })
    expect(a.code).toBe(1)
    expect(a.err.join('\n')).toMatch(/CONFIRM_REMOTE=1/)
    expect(a.opened()).toBe(0)
  })

  it('the old dormant refusal is gone: a real apply with everything in place runs', async () => {
    const c = await setup()
    const r = await runApply(c)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).not.toMatch(/not available yet/)
  })
})

// ---- group 2: order and the window (P1) ----

describe('order: control batch, secret, deploy, then the CRM batch', () => {
  it('a full run: both marks precede the CRM batch, which starts after the deploy reported success', async () => {
    const c = await setup()
    const r = await runApply(c)
    expect(r.code).toBe(0)
    expect(r.marks.map((m) => m.kind)).toEqual(['secret', 'deploy'])
    for (const m of r.marks) {
      expect(m.controlWrites).toBeGreaterThan(0) // the control batch is already in
      expect(m.crmWrites).toBe(0) // and the CRM is not touched yet
    }
    expect(r.crmWrites()).toBeGreaterThan(0)
    const u = await rows(pair.d1, 'select auth_provider from users where id = ?', U(1))
    expect(u[0]!.auth_provider).toBe('better-auth')
  })

  it('a failed deploy leaves the CRM exactly as it was and exits 2', async () => {
    const c = await setup()
    const before = await crmDump()
    const r = await runApply(c, { deployStatus: 1 })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toMatch(/the deploy failed.*CRM is untouched/)
    expect(r.crmWrites()).toBe(0)
    expect(await crmDump()).toBe(before)
    expect((await authUsers()).length).toBe(4) // the inert control rows stay
  })
})

// ---- group 3: AUTH_SECRET (P4) ----

describe('AUTH_SECRET', () => {
  it('absent: generated (32+ characters), appended mode 600 with every other line unchanged, sent only on stdin', async () => {
    const c = await setup()
    const r = await runApply(c)
    expect(r.code).toBe(0)
    const text = readFileSync(c.envFile, 'utf8')
    expect(text.startsWith(ENV_TEXT)).toBe(true)
    const appended = text.slice(ENV_TEXT.length)
    const m = /^AUTH_SECRET=(\S+)\n$/.exec(appended)
    expect(m).not.toBeNull()
    const secret = m![1]!
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(statSync(c.envFile).mode & 0o777).toBe(0o600)
    expect(r.cmds).toHaveLength(1)
    expect(r.cmds[0]!.cmd.args).toEqual(['exec', 'wrangler', 'secret', 'put', 'AUTH_SECRET', '--env', 'hq'])
    expect(r.cmds[0]!.input).toBe(secret)
    expect(r.appended()).toBe(1)
    // the value is in no argv, stdout or stderr, and neither is Clerk's key
    expect(r.everything()).not.toContain(secret)
    expect(r.everything()).not.toContain(CLERK_SECRET)
    expect(r.cmds[0]!.input).not.toContain('sk_test_')
  })

  it('present and valid: reused, the file is unchanged byte for byte, nothing is regenerated', async () => {
    const c = await setup({ envText: `${ENV_TEXT}AUTH_SECRET=${VALID_SECRET}\n` })
    const before = readFileSync(c.envFile, 'utf8')
    const r = await runApply(c)
    expect(r.code).toBe(0)
    expect(readFileSync(c.envFile, 'utf8')).toBe(before)
    expect(r.appended()).toBe(0)
    expect(r.cmds[0]!.input).toBe(VALID_SECRET)
    expect(r.everything()).not.toContain(VALID_SECRET)
    expect(r.everything()).not.toContain(CLERK_SECRET)
  })
})

// ---- group 4: stopping points and re-runs ----

describe('every stopping point exits 2 and a re-run ends applied', () => {
  type Stop = { title: string; opts: () => RunOpts; deploysBefore: number }
  const stops: Stop[] = [
    {
      title: 'the control batch fails',
      opts: () => ({ control: faultCrm(/insert into auth_users/).wrap }),
      deploysBefore: 0,
    },
    { title: 'the secret put fails', opts: () => ({ putStatus: 1 }), deploysBefore: 0 },
    { title: 'the deploy fails', opts: () => ({ deployStatus: 1 }), deploysBefore: 1 },
    { title: 'the CRM batch fails', opts: () => ({ crm: faultCrm(/^update "users"/).wrap }), deploysBefore: 1 },
    {
      title: 'the CRM batch drifts (a user changed between the export and the batch)',
      opts: () => ({
        crm: faultCrm(/^update "users"/, async () => {
          await pair.d1.prepare("update users set auth_subject = 'user_changed' where id = ?").bind(U(1)).run()
        }).wrap,
      }),
      deploysBefore: 1,
    },
  ]
  for (const s of stops) {
    it(`${s.title}: exit 2, then a re-run applies, inserts no second auth_users row, and a third run writes nothing`, async () => {
      const c = await setup()
      const first = await runApply(c, s.opts())
      expect(first.code).toBe(2)
      expect(first.marks.filter((m) => m.kind === 'deploy')).toHaveLength(s.deploysBefore)
      const driftedUser = s.title.includes('drifts')
      if (driftedUser)
        await pair.d1.prepare('update users set auth_subject = ? where id = ?').bind('user_scrubbeda', U(1)).run()
      const second = await runApply(c)
      expect(second.code).toBe(0)
      expect(await authUsers()).toHaveLength(4)
      expect((await rows(pair.d1, 'select auth_provider from deployment'))[0]!.auth_provider).toBe('better-auth')
      expect(second.marks.map((m) => m.kind)).toEqual(['secret', 'deploy'])
      // the secret the file holds is the one that was put, on both runs
      const fileSecret = /^AUTH_SECRET=(\S+)$/m.exec(readFileSync(c.envFile, 'utf8'))![1]
      expect(second.cmds[0]!.input).toBe(fileSecret)
      if (first.cmds[0]) expect(first.cmds[0].input).toBe(fileSecret)
      expect((readFileSync(c.envFile, 'utf8').match(/AUTH_SECRET=/g) ?? []).length).toBe(1)
      // applied: a further run exits 0 and runs no writing command, no deploy and no batch
      const crmBefore = await crmDump()
      const third = await runApply(c)
      expect(third.code).toBe(0)
      expect(third.out.join('\n')).toMatch(/already applied/)
      expect(third.cmds).toEqual([])
      expect(third.marks).toEqual([])
      expect(third.crmWrites() + third.controlWrites()).toBe(0)
      expect(await crmDump()).toBe(crmBefore)
    })
  }

  it('the deploy is refused (a RemoteRefusal): exit 2 with its own message, the CRM untouched, and a re-run resumes', async () => {
    const c = await setup()
    const before = await crmDump()
    const first = await runApply(c, {
      deployThrows: new RemoteRefusal('the working tree is not clean: commit or stash first'),
    })
    expect(first.code).toBe(2)
    expect(first.err.join('\n')).toMatch(/the deploy was refused \(the working tree is not clean/)
    expect(first.crmWrites()).toBe(0)
    expect(await crmDump()).toBe(before)
    const second = await runApply(c)
    expect(second.code).toBe(0)
    expect((await rows(pair.d1, 'select auth_provider from deployment'))[0]!.auth_provider).toBe('better-auth')
  })

  it('the env file cannot be appended to: exit 2 with its own message, nothing put, the CRM untouched, and a re-run resumes', async () => {
    const c = await setup()
    const before = await crmDump()
    const first = await runApply(c, { appendThrows: new Error('disk full') })
    expect(first.code).toBe(2)
    expect(first.err.join('\n')).toMatch(/AUTH_SECRET could not be written to \.env\.hq/)
    expect(first.cmds).toEqual([])
    expect(first.crmWrites()).toBe(0)
    expect(await crmDump()).toBe(before)
    const second = await runApply(c)
    expect(second.code).toBe(0)
  })

  it('an empty instance (no people, no agents) still switches the marker, and its re-run is applied', async () => {
    const c = await setup({ world: { users: [], agents: [], memberships: [] }, bodies: [] })
    const first = await runApply(c)
    expect(first.code).toBe(0)
    expect(first.marks.map((m) => m.kind)).toEqual(['secret', 'deploy'])
    expect((await rows(pair.d1, 'select auth_provider, auth_org_id from deployment'))[0]).toEqual({
      auth_provider: 'better-auth',
      auth_org_id: 'org_hq',
    })
    const again = await runApply(c)
    expect(again.code).toBe(0)
    expect(again.out.join('\n')).toMatch(/already applied/)
    expect(again.cmds).toEqual([])
    expect(again.marks).toEqual([])
  })

  it('a successful run names the next step: the exact claim command for this env and plan ([[OPS397]] P1)', async () => {
    const c = await setup()
    const r = await runApply(c)
    expect(r.out).toContain(
      `next: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- claim --env hq --plan ${c.planPath} (claim links for the people and the agent accounts, and the caps of the disabled delegated agents; until then nobody can sign in, and API keys keep working)`,
    )
  })
})

// ---- group 5: exit codes (P5) ----

describe('exit codes', () => {
  it('a failure after the control batch began is 2: the deploy, with its message', async () => {
    const c = await setup()
    expect((await runApply(c, { deployStatus: 3 })).code).toBe(2)
  })

  it("the control read-back refusal that follows this run's own control inserts is 1, names the address, and leaves the CRM untouched", async () => {
    const c = await setup()
    // an address the plan is about to insert is held by another id (a row of an earlier plan): the other rows go in first, then the read-back refuses
    const held = c.plan.snapshot.users.find(
      (u) => u.id === c.plan.people.find((p) => p.action === 'migrate')!.user_id,
    )!.email
    await pair.control
      .prepare(
        "insert into auth_users (id, name, email, email_verified, created_at, updated_at) values ('0190aaaa-ffff-7000-8000-000000000001', 'old', ?, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
      )
      .bind(held)
      .run()
    const before = await crmDump()
    const r = await runApply(c)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain(held)
    expect(r.controlWrites()).toBeGreaterThan(0)
    expect(r.cmds).toEqual([])
    expect(r.marks).toEqual([])
    expect(await crmDump()).toBe(before)
  })

  it("ApplyRefusal's docstring says what holds: the CRM is untouched, inert auth_users rows may exist", () => {
    const src = readFileSync(new URL('./auth-migrate/apply.ts', import.meta.url), 'utf8')
    const doc = /\/\*\*([\s\S]*?)\*\/\s*export class ApplyRefusal/.exec(src)?.[1] ?? ''
    expect(doc).toMatch(/CRM is untouched/)
    expect(doc).toMatch(/inert/i)
    expect(doc).not.toMatch(/nothing was written by this run/)
  })
})

// ---- group 6: D14, the deployment marker follows the provider (P6) ----

describe('the deployment marker', () => {
  it('reads better-auth after the CRM batch, auth_org_id is unchanged, and no event is emitted for it', async () => {
    const c = await setup()
    const before = (await rows(pair.d1, 'select * from deployment'))[0]!
    const r = await runApply(c)
    expect(r.code).toBe(0)
    const after = (await rows(pair.d1, 'select * from deployment'))[0]!
    expect(after).toEqual({ ...before, auth_provider: 'better-auth' })
    expect(after.auth_org_id).toBe('org_hq')
    const events = await rows(pair.d1, 'select type, resource_type from events')
    expect(events.filter((e) => /deployment/.test(`${e.type} ${e.resource_type}`))).toEqual([])
    expect(events).toHaveLength(4) // the four agent.updated of the plan, nothing for the marker
    expect(A(1)).toBeTruthy()
  })

  it('drift: a marker changed between the export and the batch aborts the whole unit; the CRM, users included, is as it was', async () => {
    const c = await setup()
    let before = ''
    const { wrap, f } = faultCrm(/update "?deployment"?/, async () => {
      await pair.d1.prepare("update deployment set auth_provider = 'none'").run()
      before = await crmDump()
    })
    const r = await runApply(c, { crm: wrap })
    expect(f.fault!.fired()).toBe(1)
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toMatch(/drift/i)
    expect(await crmDump()).toBe(before)
    expect(await rows(pair.d1, 'select id from events')).toEqual([])
    expect((await rows(pair.d1, 'select auth_provider from users where id = ?', U(1)))[0]!.auth_provider).toBe('clerk')
  })
})

// ---- the dry run, as OPS392 shipped it, over the two handles ----

describe('apply --dry-run', () => {
  it('on an instance that matches the snapshot: not applied, counts per action, no personal data, nothing written, nothing run', async () => {
    const c = await setup()
    const r = await runApply(c, { argv: ['--dry-run'] })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toMatch(/not applied/i)
    expect(text).toMatch(/dry run/i)
    expect(text).toMatch(/auth_users rows \(3 people, 1 agent account\)/)
    expect(text).toMatch(/users re-pointed: 3/)
    expect(text).toMatch(/agents relinked: 1/)
    expect(text).toMatch(/agents disabled: 3/)
    expect(text).not.toContain('@example.test')
    expect(r.crmWrites() + r.controlWrites()).toBe(0)
    expect(r.cmds).toEqual([])
    expect(r.marks).toEqual([])
    expect(r.appended()).toBe(0)
    expect(r.everything()).not.toContain(CLERK_SECRET)
    expect(c.clerk.calls.every((x) => x.method === 'GET')).toBe(true)
  })

  it('on an instance the plan is already applied to: says so, exit 0', async () => {
    const c = await setup()
    expect((await runApply(c)).code).toBe(0)
    const r = await runApply(c, { argv: ['--dry-run'] })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/already applied/i)
    expect(r.err).toEqual([])
  })

  it('a changed Clerk user: mismatch naming the Clerk user, exit 1', async () => {
    const c = await setup()
    const changed = standardClerk()
    changed[0]!.public_metadata = { vibase_role: 'member' }
    c.clerk = fakeClerk(changed, 500)
    const r = await runApply(c, { argv: ['--dry-run'] })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('user_scrubbeda')
  })

  it('a live membership whose role differs from its person role is refused naming the person', async () => {
    const world = standardWorld()
    world.memberships[0]!.role = 'member' // Clerk says owner
    const c = await setup({ world })
    const r = await runApply(c, { argv: ['--dry-run'] })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain(world.users[0]!.id)
  })
})
