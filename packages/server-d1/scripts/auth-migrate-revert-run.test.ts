// [[OPS394]]: `auth:migrate:remote -- revert` ([[OPS250]] D8, P1-P6): the refusals before any write (real run and --dry-run), the round trip plan -> apply -> revert, the guards and drift of the CRM unit,
// the order (CRM batch, then the deploy) and its stopping points, and that the control database and every secret are left alone.
// The two databases are local D1s (Miniflare's real D1 and SQLite semantics) behind the same handles the real run opens remotely; the deploy is faked at the command boundary, as in apply's suite.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from '@vibase/auth'
import {
  CONTROL_MIGRATIONS,
  MIGRATIONS,
  controlAuthDatabase,
  openControlDb,
  writeControlMarker,
  type D1Like,
} from '@vibase/storage-d1'
import { seedPrincipal } from '@vibase/storage-d1/test/seed'
import { composeD1Worker } from '../src/compose.js'
import { AUTH_BASE, AUTH_SECRET } from '../src/test/auth-kit.js'
import { faultD1, openWorkerPair, spyD1, type WorkerPair } from '../src/test/kit.js'
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
import type { Cmd } from './remote.js'

const { U, A } = ids
const CRM_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CTL_ID = '9f8e7d6c-5b4a-4398-8765-4321fedcba98'
const GOOD = { CONFIRM_REMOTE: '1' }
const WRITE = /^\s*(insert|update|delete|replace)\b/i
const CLERK = { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: 'https://clerk.hq.example.test' }
const BETTER_AUTH = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: 'https://api.hq.vibase.ai' }
const config = (vars: Record<string, unknown> = CLERK) => ({
  name: 'vault-hq',
  d1_databases: [
    { binding: 'DB', database_name: 'vault-crm-hq', database_id: CRM_ID, remote: true },
    { binding: 'CONTROL_DB', database_name: 'vault-control-hq', database_id: CTL_ID, remote: true },
  ],
  vars,
})
const VALID_SECRET = 'an-auth-secret-that-is-long-enough-0123456789abcdef'
const ENV_TEXT = `CLERK_SECRET_KEY=${CLERK_SECRET}\nAUTH_SECRET=${VALID_SECRET}\nOTHER=x\n`

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
const crmDump = async (): Promise<string> =>
  JSON.stringify(await Promise.all(TABLES.map(async (t) => [t, await rows(pair.d1, `select * from ${t} order by 1`)])))
const controlDump = async (): Promise<string> =>
  JSON.stringify(
    await Promise.all(
      ['auth_users', 'auth_accounts', 'auth_sessions', 'control_deployment', 'control_audit', 'api_keys'].map(
        async (t) => [t, await rows(pair.control, `select * from ${t} order by 1`)],
      ),
    ),
  )

/** The standard vault plus a person Clerk gives the member role and who has no membership yet: apply inserts one, so revert has a membership to soft-delete. */
function worldWithInsert(): World {
  const w = standardWorld()
  w.users.push({
    id: U(6),
    email: 'e@example.test',
    name: null,
    auth_provider: 'clerk',
    auth_subject: 'user_scrubbede',
    email_verified: true,
  })
  return w
}

interface Ctx {
  dir: string
  planPath: string
  envFile: string
  plan: AuthPlan
  clerk: ReturnType<typeof fakeClerk>
  bodies: Array<Record<string, any>>
}
/** The vault seeded, the plan, its env file, and apply already run (the starting point of a revert). */
async function setupApplied(o: { world?: World; bodies?: Array<Record<string, any>>; pair?: boolean } = {}): Promise<Ctx> {
  const world = o.world ?? worldWithInsert()
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
  const clerkRows = await clerkRowsOf(bodies)
  const snapshot = await readSnapshot(pair.d1, clerkRows)
  const plan = planOf(snapshot)
  plan.crm = { database_name: 'vault-crm-hq', database_id: CRM_ID, bookmark: 'B1' }
  plan.control = { database_name: 'vault-control-hq', database_id: CTL_ID, bookmark: 'B2' }
  let n = 0
  await applyBatches({
    plan,
    fresh: snapshot,
    crm: pair.d1,
    control: pair.control,
    now: () => new Date('2026-11-17T09:00:00.000Z'),
    newId: () => `0190eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  })
  const dir = mkdtempSync(join(tmpdir(), 'auth-revert-'))
  dirs.push(dir)
  const planPath = join(dir, 'hq.auth-plan.json')
  writeFileSync(planPath, JSON.stringify(plan))
  const envFile = join(dir, '.env.hq')
  writeFileSync(envFile, ENV_TEXT, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  return { dir, planPath, envFile, plan, clerk: fakeClerk(bodies, 500), bodies }
}

interface Mark {
  controlWrites: number
  crmWrites: number
  /** the deployment marker when the deploy started */
  marker: string
}
interface RunOpts {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  cfg?: ReturnType<typeof config>
  crm?: (d1: D1Like) => D1Like
  dirty?: string
  deployStatus?: number
  deployThrows?: Error
}
/** One run of the command: its exit code and everything it did at the boundaries. */
async function runRevert(c: Ctx, o: RunOpts = {}) {
  const crmSpy = spyD1(pair.d1)
  const ctlSpy = spyD1(pair.control)
  const marks: Mark[] = []
  const cmds: Array<{ cmd: Cmd; input: string | undefined }> = []
  const out: string[] = []
  const err: string[] = []
  let opened = 0
  let appended = 0
  const writes = (s: { log: { statements: string[] } }) => s.log.statements.filter((q) => WRITE.test(q)).length
  const deps: PlanDeps = {
    loadEnv: () => {},
    readConfig: () => o.cfg ?? config(),
    readInstanceEnv: () => ({ display: '.env.hq', status: 'ok', text: readFileSync(c.envFile, 'utf8') }),
    exec: () => {
      throw new Error('revert reads through the opened handles, not through wrangler')
    },
    fetch: c.clerk.fetch,
    exists: () => false,
    repoPathNotIgnored: () => false,
    readText: (p) => readFileSync(p, 'utf8'),
    writeNew: () => {
      throw new Error('revert writes no plan file')
    },
    withDatabases: async (_env, fn) => {
      opened++
      return fn({ crm: o.crm ? o.crm(crmSpy.d1) : crmSpy.d1, control: ctlSpy.d1 })
    },
    run: (cmd, input) => {
      cmds.push({ cmd, input })
      return 0
    },
    git: (args) => ({ status: 0, stdout: args[0] === 'status' ? (o.dirty ?? '') : 'abc123\n' }),
    appendEnvVar: () => {
      appended++
    },
    deploy: () => {
      marks.push({ controlWrites: writes(ctlSpy), crmWrites: writes(crmSpy), marker: '' })
      if (o.deployThrows) throw o.deployThrows
      return o.deployStatus ?? 0
    },
    now: () => new Date('2026-11-18T09:00:00.000Z'),
    newId: (() => {
      let n = 0
      return () => `0190ffff-0000-7000-8000-${String(++n).padStart(12, '0')}`
    })(),
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  } as unknown as PlanDeps
  const code = await runAuthMigrate(
    ['revert', '--env', 'hq', '--plan', c.planPath, ...(o.argv ?? [])],
    o.env ?? GOOD,
    deps,
  )
  return {
    code,
    out,
    err,
    marks,
    cmds,
    opened: () => opened,
    appended: () => appended,
    crmWrites: () => writes(crmSpy),
    controlWrites: () => writes(ctlSpy),
    everything: () => [...out, ...err, ...cmds.flatMap((x) => [x.cmd.command, ...x.cmd.args, x.input ?? ''])].join('\n'),
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
const marker = async () => (await rows(pair.d1, 'select auth_provider from deployment'))[0]!.auth_provider as string
const eventsNow = () => rows(pair.d1, 'select id, type, resource_type, resource_id, actor_id from events order by id')
const restoredSnapshot = (c: Ctx) => readSnapshot(pair.d1, c.plan.snapshot.clerk_users)

// ---- group 1: refused before any write, exit 1 (P2, P3, P5): each case on the real run and on --dry-run ----

describe('revert refuses before any write', () => {
  const cases: Array<[string, (c: Ctx) => Promise<RunOpts | undefined> | RunOpts | undefined, RegExp]> = [
    [
      'the env block still has better-auth (the apply-time config commit is not reverted)',
      () => ({ cfg: config(BETTER_AUTH) }),
      /provider switch back is not committed.*git revert/s,
    ],
    [
      'the env block says clerk but the Worker would refuse it (no CLERK_ISSUER)',
      () => ({ cfg: config({ AUTH_PROVIDER: 'clerk' }) }),
      /does not parse as a Clerk config/,
    ],
    [
      'the git tree is not clean',
      () => ({ dirty: ' M packages/server-d1/wrangler.jsonc\n' }),
      /commit the revert of the provider switch/,
    ],
    [
      'the CRM database has a pending migration',
      async () => {
        await pair.d1.prepare('delete from d1_migrations where name = ?').bind(MIGRATIONS.at(-1)!.name).run()
      },
      /CRM database has pending migrations.*db:migrate:remote/,
    ],
    ['a plan file that is missing', (c) => void rmSync(c.planPath), /missing or unreadable/],
    [
      'a user created since apply',
      async () => {
        await seedPrincipal(pair.d1, {
          id: U(90),
          kind: 'user',
          email: 'new@example.test',
          name: null,
          authProvider: 'better-auth',
          authSubject: 'newbie',
          emailVerified: true,
        })
      },
      /instance is neither as the plan applied it nor as the plan found it/,
    ],
    [
      'an agent changed since apply',
      async () => void (await pair.d1.prepare("update agents set name = 'renamed' where id = ?").bind(A(1)).run()),
      /instance is neither.*agents row/,
    ],
    [
      'a membership added since apply',
      async () => {
        await pair.d1
          .prepare(
            "insert into memberships (id, created_at, updated_at, organization_id, user_id, role, created_by) values (?, '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z', ?, ?, 'member', ?)",
          )
          .bind(U(120), ORG_ID, U(3), U(1))
          .run()
      },
      /instance is neither.*membership/,
    ],
    [
      'a re-pointed subject that differs from the plan (the user signed in elsewhere)',
      async () => void (await pair.d1.prepare("update users set auth_subject = 'other' where id = ?").bind(U(1)).run()),
      /instance is neither.*users row/,
    ],
    [
      'the deployment marker is neither the applied nor the original provider',
      async () => void (await pair.d1.prepare("update deployment set auth_provider = 'none'").run()),
      /instance is neither.*deployment marker/,
    ],
  ]
  for (const dry of [false, true]) {
    for (const [title, change, match] of cases) {
      it(`${dry ? '--dry-run: ' : ''}${title}: exit 1, the message, nothing written, no deploy, no secret`, async () => {
        const c = await setupApplied()
        const run = (await change(c)) ?? {}
        const crmBefore = await crmDump()
        const ctlBefore = await controlDump()
        const envBefore = readFileSync(c.envFile, 'utf8')
        const r = await runRevert(c, { ...run, argv: dry ? ['--dry-run'] : [] })
        expect(r.code).toBe(1)
        expect(r.err.join('\n')).toMatch(match)
        expect(r.err.join('\n')).not.toMatch(/revert is #394|only the plan, apply and claim/)
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

  it('a mismatch names the last resort: Time Travel to the plan bookmarks, which the tool never runs', async () => {
    const c = await setupApplied()
    await pair.d1.prepare("update users set auth_subject = 'other' where id = ?").bind(U(1)).run()
    const r = await runRevert(c)
    expect(r.code).toBe(1)
    const msg = r.err.join('\n')
    expect(msg).toMatch(/Time Travel/)
    expect(msg).toContain('B1')
    expect(msg).toContain('B2')
    expect(r.cmds).toEqual([])
  })

  it('the inherited guards: no CONFIRM_REMOTE=1 refuses before the databases are opened', async () => {
    const c = await setupApplied()
    const r = await runRevert(c, { env: {} })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/CONFIRM_REMOTE=1/)
    expect(r.opened()).toBe(0)
  })

  it('a plan made for another env is refused', async () => {
    const c = await setupApplied()
    writeFileSync(c.planPath, JSON.stringify({ ...c.plan, env: 'smoked1' }))
    const r = await runRevert(c)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/made for env smoked1/)
  })
})

// ---- group 2: the round trip (P4) ----

describe('the round trip: plan, apply, revert', () => {
  it('a fresh export equals the plan snapshot; users re-pointed with no event; one event per touched agent and removed membership, as the system principal; keep agents untouched; the marker is back', async () => {
    const c = await setupApplied()
    const { plan } = c
    const relinked = plan.agents.filter((a) => a.action === 'relink')
    const disabled = plan.agents.filter((a) => a.action === 'disable')
    const keep = plan.agents.filter((a) => a.action === 'keep')
    expect(relinked.length).toBeGreaterThan(0)
    expect(disabled.length).toBeGreaterThan(0)
    expect(keep.some((a) => plan.snapshot.agents.find((x) => x.id === a.id)!.disabled_at !== null)).toBe(true)
    const inserted = await rows(pair.d1, "select id from memberships where user_id = ? and deleted_at is null", U(6))
    expect(inserted).toHaveLength(1)
    const before = await eventsNow()
    const keepBefore = await Promise.all(keep.map((a) => rows(pair.d1, 'select * from agents where id = ?', a.id)))
    const orgBefore = (await rows(pair.d1, 'select auth_org_id from deployment'))[0]!.auth_org_id

    const r = await runRevert(c)
    expect(r.code, r.err.join('\n')).toBe(0)

    expect(await restoredSnapshot(c)).toEqual(plan.snapshot)
    expect(await marker()).toBe('clerk')
    expect((await rows(pair.d1, 'select auth_org_id from deployment'))[0]!.auth_org_id).toBe(orgBefore)
    const fresh = (await eventsNow()).filter((e) => !before.some((b) => b.id === e.id))
    const system = (await rows(pair.d1, "select id from principals where kind = 'system'"))[0]!.id
    expect(fresh.every((e) => e.actor_id === system)).toBe(true)
    expect(fresh.filter((e) => e.type === 'agent.updated').map((e) => e.resource_id).sort()).toEqual(
      [...relinked, ...disabled].map((a) => a.id).sort(),
    )
    expect(fresh.filter((e) => e.type === 'membership.deleted').map((e) => e.resource_id)).toEqual([inserted[0]!.id])
    expect(fresh).toHaveLength(relinked.length + disabled.length + 1) // nothing for users, nothing for the marker
    expect(await Promise.all(keep.map((a) => rows(pair.d1, 'select * from agents where id = ?', a.id)))).toEqual(keepBefore)
    // the inserted membership is soft-deleted, not removed
    expect(await rows(pair.d1, 'select deleted_at from memberships where id = ?', inserted[0]!.id)).toEqual([
      { deleted_at: '2026-11-18T09:00:00.000Z' },
    ])
    // the removal event carries the removed row as `before` and no `after`
    const del = (await rows(pair.d1, "select before, after from events where type = 'membership.deleted' order by id desc"))[0]!
    expect(JSON.parse(del.before as string)).toMatchObject({ id: inserted[0]!.id, user_id: U(6), role: 'member' })
    expect(del.after).toBeNull()
  })

  it('an empty instance (no people, no agents) restores only the marker, and its re-run is the restored path', async () => {
    const c = await setupApplied({ world: { users: [], agents: [], memberships: [] }, bodies: [] })
    expect(await marker()).toBe('better-auth')
    const before = await eventsNow()
    const r = await runRevert(c)
    expect(r.code, r.err.join('\n')).toBe(0)
    expect(await marker()).toBe('clerk')
    expect(await eventsNow()).toEqual(before)
    const again = await runRevert(c)
    expect(again.code).toBe(0)
    expect(again.out.join('\n')).toMatch(/already matches the plan/)
    expect(again.crmWrites()).toBe(0)
  })

  it('--dry-run on an applied instance prints counts per kind, writes nothing, deploys nothing', async () => {
    const c = await setupApplied()
    const before = await crmDump()
    const r = await runRevert(c, { argv: ['--dry-run'] })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/users restored: \d+, agents relinked back: \d+, agents re-enabled: \d+, memberships removed: 1/)
    expect(r.out.join('\n')).toMatch(/dry run: nothing written/)
    expect(r.crmWrites()).toBe(0)
    expect(r.marks).toEqual([])
    expect(await crmDump()).toBe(before)
    expect(await marker()).toBe('better-auth')
  })
})

// ---- group 3: guards and drift (the whole unit aborts, exit 2, a re-run classifies afresh) ----

describe('drift between the export and the batch aborts the whole unit', () => {
  const kinds: Array<[string, RegExp, () => Promise<void>]> = [
    [
      "a user's subject",
      /^update "users"/,
      async () => void (await pair.d1.prepare("update users set auth_subject = 'user_changed' where id = ?").bind(U(2)).run()),
    ],
    [
      'an agent',
      /^update "agents"/,
      async () => void (await pair.d1.prepare("update agents set auth_client_id = 'client_changed' where id = ?").bind(A(3)).run()),
    ],
    [
      'a membership',
      /^update "memberships"/,
      async () => void (await pair.d1.prepare("update memberships set role = 'owner' where user_id = ? and deleted_at is null", ).bind(U(6)).run()),
    ],
    [
      'the marker',
      /update deployment/,
      async () => void (await pair.d1.prepare("update deployment set auth_provider = 'none'").run()),
    ],
  ]
  for (const [title, match, change] of kinds) {
    it(`${title}: exit 2, the CRM is exactly as before, no deploy, and a re-run refuses (the state is read afresh)`, async () => {
      const c = await setupApplied()
      let before = ''
      let events = 0
      const { wrap, f } = faultCrm(match, async () => {
        await change()
        before = await crmDump()
        events = (await eventsNow()).length
      })
      const r = await runRevert(c, { crm: wrap })
      expect(f.fault!.fired()).toBe(1)
      expect(r.code).toBe(2)
      expect(r.err.join('\n')).toMatch(/drift/i)
      expect(r.marks).toEqual([])
      expect(await crmDump()).toBe(before)
      expect((await eventsNow()).length).toBe(events)
      const again = await runRevert(c)
      expect(again.code).toBe(1)
      expect(again.err.join('\n')).toMatch(/instance is neither/)
    })
  }
})

// ---- group 4: order and stopping points (P1, P5) ----

describe('order: the CRM batch commits before the deploy starts', () => {
  it('a full run: the deploy starts after the batch, with the CRM already restored and the control database untouched', async () => {
    const c = await setupApplied()
    const r = await runRevert(c)
    expect(r.code).toBe(0)
    expect(r.marks).toHaveLength(1)
    expect(r.marks[0]!.crmWrites).toBeGreaterThan(0)
    expect(r.marks[0]!.controlWrites).toBe(0)
  })

  it('a failed batch runs no deploy (exit 2), and its re-run does the full revert', async () => {
    const c = await setupApplied()
    const before = await crmDump()
    const r = await runRevert(c, { crm: faultCrm(/^update "users"/).wrap })
    expect(r.code).toBe(2)
    expect(r.marks).toEqual([])
    expect(await crmDump()).toBe(before)
    const again = await runRevert(c)
    expect(again.code).toBe(0)
    expect(again.marks).toHaveLength(1)
    expect(again.crmWrites()).toBeGreaterThan(0)
    expect(await restoredSnapshot(c)).toEqual(c.plan.snapshot)
    expect(await marker()).toBe('clerk')
  })

  it('a failed deploy leaves the CRM restored (exit 2), and its re-run runs no batch, deploys and exits 0', async () => {
    const c = await setupApplied()
    const r = await runRevert(c, { deployStatus: 1 })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toMatch(/the deploy failed.*CRM is already restored.*re-run revert/s)
    expect(await restoredSnapshot(c)).toEqual(c.plan.snapshot)
    expect(await marker()).toBe('clerk')
    const again = await runRevert(c)
    expect(again.code).toBe(0)
    expect(again.crmWrites()).toBe(0)
    expect(again.marks).toHaveLength(1)
    expect(again.out.join('\n')).toMatch(/already matches the plan/)
  })

  it('a run on a restored CRM deploys again and exits 0; a dry run on it deploys nothing', async () => {
    const c = await setupApplied()
    expect((await runRevert(c)).code).toBe(0)
    const dry = await runRevert(c, { argv: ['--dry-run'] })
    expect(dry.code).toBe(0)
    expect(dry.marks).toEqual([])
    expect(dry.out.join('\n')).toMatch(/already matches the plan/)
    const again = await runRevert(c)
    expect(again.code).toBe(0)
    expect(again.marks).toHaveLength(1)
    expect(again.crmWrites()).toBe(0)
  })

  it('a refused deploy (it throws) is exit 2 with its own message and the CRM restored', async () => {
    const c = await setupApplied()
    const r = await runRevert(c, { deployThrows: new Error('the working tree is not clean') })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toMatch(/the deploy was refused \(the working tree is not clean\).*CRM is already restored/s)
    expect(await marker()).toBe('clerk')
  })
})

// ---- the premise of P1: restored CRM, Worker still on Better Auth ----

describe('P1 premise: in the window the Better Auth Worker locks the person out and creates nothing', () => {
  let ip = 0
  const post = (wk: ReturnType<typeof composeD1Worker>, path: string, body: unknown) =>
    wk.fetch(
      new Request(AUTH_BASE + path, {
        method: 'POST',
        headers: { origin: AUTH_BASE, 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++ip}` },
        body: JSON.stringify(body),
      }),
    )
  it('a claimed person signs in on Better Auth after the CRM batch: refused, and no users or memberships row is made', async () => {
    const c = await setupApplied()
    const r = await runRevert(c)
    expect(r.code).toBe(0)
    const counts = async () => ({
      users: await rows(pair.d1, 'select count(*) n from users'),
      principals: await rows(pair.d1, 'select count(*) n from principals'),
      memberships: await rows(pair.d1, 'select count(*) n from memberships'),
    })
    const before = await counts()
    const auth = createAuth(controlAuthDatabase(openControlDb(pair.control)), { secret: AUTH_SECRET, baseURL: AUTH_BASE })
    const issued = await auth.issueResetToken('a@example.test')
    expect(issued).not.toBeNull()
    const wk = composeD1Worker({
      DB: pair.d1,
      CONTROL_DB: pair.control,
      AUTH_PROVIDER: 'better-auth',
      AUTH_SECRET,
      PUBLIC_BASE_URL: AUTH_BASE,
    })
    const done = await post(wk, '/auth/reset-password', { token: issued!.token, newPassword: 'a brand new password 456' })
    expect(done.status).toBe(200)
    const signIn = await post(wk, '/auth/sign-in/email', { email: 'a@example.test', password: 'a brand new password 456' })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!
    const tokRes = await wk.fetch(new Request(`${AUTH_BASE}/auth/token`, { headers: { cookie, origin: AUTH_BASE } }))
    const token = ((await tokRes.json()) as { token: string }).token
    const me = await wk.fetch(new Request(`${AUTH_BASE}/meta/v1/me`, { headers: { authorization: `Bearer ${token}` } }))
    expect([401, 403]).toContain(me.status)
    expect(await counts()).toEqual(before)
  })
})

// ---- group 5: control untouched, nothing leaks (P3, P6) ----

describe('the control database is untouched and no secret leaks', () => {
  it('after a claim, revert leaves every control table row for row, runs no secret put or delete, lists the claimed account by email, and prints no secret', async () => {
    const c = await setupApplied()
    const person = c.plan.people.find((p) => p.action === 'migrate' && p.email === 'a@example.test')!
    await pair.control
      .prepare(
        "insert into auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) values ('acc1', ?, 'credential', ?, 'hash:credential', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z')",
      )
      .bind(person.new_auth_user_id, person.new_auth_user_id)
      .run()
    const ctlBefore = await controlDump()
    const envBefore = readFileSync(c.envFile, 'utf8')
    const r = await runRevert(c)
    expect(r.code, r.err.join('\n')).toBe(0)
    expect(await controlDump()).toBe(ctlBefore)
    expect(r.controlWrites()).toBe(0)
    expect(r.cmds).toEqual([]) // no wrangler secret put or delete, no other writing command
    expect(r.appended()).toBe(0)
    expect(readFileSync(c.envFile, 'utf8')).toBe(envBefore) // AUTH_SECRET stays in the file
    const out = r.out.join('\n')
    expect(out).toMatch(/left inert: a@example\.test/)
    expect(out).not.toMatch(/left inert: b@example\.test/) // never claimed: nothing to say
    for (const secret of [CLERK_SECRET, VALID_SECRET, 'hash:credential'])
      expect(r.everything()).not.toContain(secret)
  })

  it('the claim lines also appear on --dry-run, and the control rows are the same', async () => {
    const c = await setupApplied()
    const person = c.plan.people.find((p) => p.action === 'migrate' && p.email === 'a@example.test')!
    await pair.control
      .prepare(
        "insert into auth_accounts (id, account_id, provider_id, user_id, created_at, updated_at) values ('acc1', ?, 'credential', ?, '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z')",
      )
      .bind(person.new_auth_user_id, person.new_auth_user_id)
      .run()
    const r = await runRevert(c, { argv: ['--dry-run'] })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/left inert: a@example\.test/)
  })
})
