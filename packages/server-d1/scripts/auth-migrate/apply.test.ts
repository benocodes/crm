// [[OPS392]]: the control batch and the CRM batch of the hq auth migration, over two local D1 databases (Miniflare's real D1 and SQLite semantics, so atomicity and drift are real).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { seedPrincipal } from '@vibase/storage-d1/test/seed'
import { faultD1, openWorkerPair, spyD1, type WorkerPair } from '../../src/test/kit.js'
import {
  ApplyFailure,
  ApplyRefusal,
  EXIT_FAILED_AFTER_WRITE,
  EXIT_REFUSED,
  applyBatches,
  applyControlBatch,
  assessState,
  describePlan,
  exitCodeFor,
} from './apply.js'
import {
  ORG_ID,
  clerkRowsOf,
  ids,
  planOf,
  readSnapshot,
  seedWorld,
  standardClerk,
  standardWorld,
  type World,
} from './test-kit.js'
import type { AuthPlan, ClerkUserRow, Snapshot } from './types.js'

const { U, A } = ids
const NOW = new Date('2026-11-17T09:00:00.000Z')
let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
afterEach(async () => {
  await pair.reset()
})

const rows = async (d1: D1Like, q: string, ...b: unknown[]) =>
  ((
    await d1
      .prepare(q)
      .bind(...b)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const WRITE = /^\s*(insert|update|delete|replace)\b/i

/** u1 owner and u2 member (live memberships), u3 whose Clerk user has no role, u4 vault-only, u5 unlinked, plus u6: a Clerk member (user e) with no membership yet. */
function applyWorld(): World {
  const w = standardWorld()
  w.users[0]!.name = 'Alice'
  w.users[2]!.email = 'd-vault@example.test' // Clerk's is d@example.test: not the same address, so not verified
  w.users.push({
    id: U(6),
    email: 'e@example.test',
    name: 'Eve',
    auth_provider: 'clerk',
    auth_subject: 'user_scrubbede',
    email_verified: true,
  })
  return w
}

interface Seeded {
  clerk: ClerkUserRow[]
  snapshot: Snapshot
  plan: AuthPlan
}
/** Seeds the world into the CRM database and plans from what the real reader finds there. Clerk has not verified Eve's address, and spells Bea's with capitals. */
async function seed(world: World = applyWorld()): Promise<Seeded> {
  await seedWorld(pair.d1, world)
  const clerk = await clerkRowsOf(standardClerk())
  clerk.find((c) => c.id === 'user_scrubbede')!.email_verified = false
  clerk.find((c) => c.id === 'user_scrubbedb')!.email = 'B@Example.test' // the vault keeps lower case: equal ignoring case, so verified
  const snapshot = await readSnapshot(pair.d1, clerk)
  return { clerk, snapshot, plan: planOf(snapshot) }
}

const run = (s: Seeded, o: { crm?: D1Like; control?: D1Like; fresh?: Snapshot; plan?: AuthPlan } = {}) =>
  applyBatches({
    plan: o.plan ?? s.plan,
    fresh: o.fresh ?? s.snapshot,
    crm: o.crm ?? pair.d1,
    control: o.control ?? pair.control,
    now: () => NOW,
    newId: (() => {
      let n = 0
      return () => `0190eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`
    })(),
  })

const TABLES = ['principals', 'users', 'agents', 'memberships', 'events', 'organizations', 'deployment']
/** Every row of the CRM tables that matter, as text. */
async function crmDump(): Promise<string> {
  return JSON.stringify(
    await Promise.all(TABLES.map(async (t) => [t, await rows(pair.d1, `select * from ${t} order by 1`)])),
  )
}
async function controlDump(skip: string[] = []): Promise<string> {
  const tables = (
    await rows(
      pair.control,
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'",
    )
  )
    .map((r) => r.name as string)
    .filter((t) => !skip.includes(t))
  return JSON.stringify(
    await Promise.all(tables.map(async (t) => [t, await rows(pair.control, `select * from "${t}"`)])),
  )
}
const authUsers = () =>
  rows(pair.control, 'select id, name, email, email_verified, created_at, updated_at from auth_users order by id')

/** A refusal: the error is an ApplyRefusal, and neither database changed by a single row. */
async function expectRefused(s: Seeded, match: RegExp, o: Parameters<typeof run>[1] = {}) {
  const crm = spyD1(pair.d1)
  const control = spyD1(pair.control)
  const before = [await crmDump(), await controlDump()]
  const err = await run(s, { ...o, crm: crm.d1, control: control.d1 }).then(
    () => null,
    (e) => e,
  )
  expect(err).toBeInstanceOf(ApplyRefusal)
  expect((err as Error).message).toMatch(match)
  expect(exitCodeFor(err)).toBe(EXIT_REFUSED)
  expect([...crm.log.statements, ...control.log.statements].filter((q) => WRITE.test(q))).toEqual([])
  expect([await crmDump(), await controlDump()]).toEqual(before)
  expect(await rows(pair.d1, 'select id from events')).toEqual([])
}

// group 1: refused before any write.
describe('a plan the instance no longer matches is refused before any write (D3)', () => {
  it('a changed Clerk user (its address)', async () => {
    const s = await seed()
    const fresh = structuredClone(s.snapshot)
    fresh.clerk_users.find((c) => c.id === 'user_scrubbeda')!.email = 'changed@example.test'
    await expectRefused(s, /user_scrubbeda/, { fresh })
  })
  it('a Clerk user that appeared', async () => {
    const s = await seed()
    const fresh = structuredClone(s.snapshot)
    fresh.clerk_users.push({ id: 'user_new', email: 'n@example.test', email_verified: true, role: 'member' })
    await expectRefused(s, /user_new/, { fresh })
  })
  it('a changed users row (its name)', async () => {
    const s = await seed()
    const fresh = structuredClone(s.snapshot)
    fresh.users.find((u) => u.id === U(1))!.name = 'Renamed'
    await expectRefused(s, new RegExp(U(1)), { fresh })
  })
  it('a changed agents row (its scopes)', async () => {
    const s = await seed()
    const fresh = structuredClone(s.snapshot)
    fresh.agents.find((a) => a.id === A(1))!.scopes = ['contacts:read', 'notes:write']
    await expectRefused(s, new RegExp(A(1)), { fresh })
  })
  it('a changed membership (its role)', async () => {
    const s = await seed()
    const fresh = structuredClone(s.snapshot)
    fresh.memberships.find((m) => m.user_id === U(2))!.role = 'owner'
    await expectRefused(s, new RegExp(U(2)), { fresh })
  })
  it('the comparison is strict: a differing row is named by id, with every other row equal', async () => {
    const s = await seed()
    const fresh = structuredClone(s.snapshot)
    fresh.users.find((u) => u.id === U(5))!.name = 'x'
    let message = ''
    try {
      assessState(s.plan, fresh)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain(U(5))
    expect(message).not.toContain(U(4))
  })
  it('a live membership whose role differs from the plan role is refused naming the person (P5)', async () => {
    const w = applyWorld()
    w.memberships.find((m) => m.user_id === U(1))!.role = 'member' // Clerk says owner
    const s = await seed(w)
    await expectRefused(s, new RegExp(U(1)))
  })
})

// group 2: the control batch (P4).
describe('the control batch', () => {
  it('writes an auth_users row for every migrate person and relink agent, with the plan ids, emails, names and verified flags', async () => {
    const s = await seed()
    await run(s)
    const byId = new Map((await authUsers()).map((r) => [r.id as string, r]))
    const person = (n: number) => s.plan.people.find((p) => p.user_id === U(n))!
    const agent = s.plan.agents.find((a) => a.id === A(2))!
    expect(byId.size).toBe(5) // u1, u2, u3, u6 and the agent account; none for none/keep/disable
    expect(byId.get(person(1).new_auth_user_id!)).toMatchObject({
      email: 'a@example.test',
      name: 'Alice',
      email_verified: 1,
    })
    // name falls back to the email; verified ignores case
    expect(byId.get(person(2).new_auth_user_id!)).toMatchObject({
      email: 'b@example.test',
      name: 'b@example.test',
      email_verified: 1,
    })
    // the vault address is not Clerk's primary: not verified
    expect(byId.get(person(3).new_auth_user_id!)).toMatchObject({ email: 'd-vault@example.test', email_verified: 0 })
    // Clerk did not verify the address: not verified
    expect(byId.get(person(6).new_auth_user_id!)).toMatchObject({
      email: 'e@example.test',
      name: 'Eve',
      email_verified: 0,
    })
    // an agent account: Clerk's primary address, the agent's name
    expect(byId.get(agent.new_auth_user_id!)).toMatchObject({
      email: 'c@example.test',
      name: 'account',
      email_verified: 1,
    })
    for (const r of byId.values()) expect(r.created_at).toBe(NOW.toISOString())
  })

  it('a second run inserts nothing', async () => {
    const s = await seed()
    expect((await applyControlBatch(pair.control, s.plan, NOW)).inserted).toBe(5)
    const before = await authUsers()
    expect((await applyControlBatch(pair.control, s.plan, NOW)).inserted).toBe(0)
    expect(await authUsers()).toEqual(before)
  })

  it('an email held by another id is refused before the CRM batch, naming the email and the plan file that minted the row', async () => {
    const s = await seed()
    const old = planOf(s.snapshot, 100) // a discarded plan: the same people, other ids
    await applyControlBatch(pair.control, old, NOW)
    const crmBefore = await crmDump()
    const err = await run(s).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(ApplyRefusal)
    expect((err as Error).message).toContain('a@example.test')
    expect((err as Error).message).toMatch(/plan file that minted/i)
    expect(exitCodeFor(err)).toBe(EXIT_REFUSED)
    expect(await crmDump()).toEqual(crmBefore)
    expect(await rows(pair.d1, 'select id from events')).toEqual([])
  })

  it('a plan id held with a different email is refused before the CRM batch', async () => {
    const s = await seed()
    const p = s.plan.people.find((x) => x.user_id === U(1))!
    await pair.control
      .prepare(
        'insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)',
      )
      .bind(p.new_auth_user_id, 'Else', 'someone-else@example.test', NOW.toISOString(), NOW.toISOString())
      .run()
    const crmBefore = await crmDump()
    await expect(run(s)).rejects.toBeInstanceOf(ApplyRefusal)
    expect(await crmDump()).toEqual(crmBefore)
  })
})

// group 3: the CRM batch matrix.
describe('the CRM batch', () => {
  async function applied(world?: World) {
    const s = await seed(world)
    // earlier history that must survive: an api key (control) and an event
    await seedPrincipal(pair.d1, { id: U(9), kind: 'user', email: 'u9@example.test' })
    await pair.d1
      .prepare(
        "insert into events (id, created_at, organization_id, type, resource_type, resource_id, actor_id, before, after) values (?, ?, ?, 'user.seeded', 'user', ?, ?, null, null)",
      )
      .bind('0190ffff-0000-7000-8000-000000000001', '2026-10-01T00:00:00.000Z', ORG_ID, U(1), U(1))
      .run()
    await pair.control
      .prepare(
        'insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        '0190ffff-0000-7000-8000-000000000002',
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
        ORG_ID,
        A(1),
        'hash',
        'pfx',
        U(1),
      )
      .run()
    const before = {
      principals: await rows(pair.d1, 'select id, kind from principals order by id'),
      users: await rows(pair.d1, 'select id from users order by id'),
      agents: await rows(pair.d1, 'select id from agents order by id'),
      events: await rows(pair.d1, 'select * from events order by id'),
      keys: await rows(pair.control, 'select * from api_keys'),
      usersFull: await rows(pair.d1, 'select * from users order by id'),
      agentsFull: await rows(pair.d1, 'select * from agents order by id'),
      memberships: await rows(pair.d1, 'select * from memberships order by id'),
    }
    const out = await run(s)
    return { s, out, before }
  }
  const person = (s: Seeded, n: number) => s.plan.people.find((p) => p.user_id === U(n))!
  const userRow = async (n: number) => (await rows(pair.d1, 'select * from users where id = ?', U(n)))[0]!
  const agentRow = async (n: number) => (await rows(pair.d1, 'select * from agents where id = ?', A(n)))[0]!

  it('people: migrate re-points, a missing membership is inserted with membership.created, a same-role one is left alone, role null gets none, none is untouched', async () => {
    const { s, before } = await applied()
    for (const n of [1, 2, 3, 6])
      expect(await userRow(n)).toMatchObject({
        auth_provider: 'better-auth',
        auth_subject: person(s, n).new_auth_user_id,
      })
    for (const n of [4, 5]) expect(await userRow(n)).toEqual(before.usersFull.find((u) => u.id === U(n)))
    // memberships: the two live ones are exactly as they were; Eve got one; Dee (role null) none
    const live = await rows(pair.d1, 'select * from memberships where deleted_at is null order by user_id')
    expect(live.map((m) => [m.user_id, m.role])).toEqual([
      [U(1), 'owner'],
      [U(2), 'member'],
      [U(6), 'member'],
    ])
    for (const m of before.memberships)
      expect(await rows(pair.d1, 'select * from memberships where id = ?', m.id)).toEqual([m])
    const events = await rows(pair.d1, "select * from events where type = 'membership.created'")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ resource_type: 'membership', organization_id: ORG_ID, before: null })
    expect(events[0]!.resource_id).toBe(live.find((m) => m.user_id === U(6))!.id)
    expect(JSON.parse(events[0]!.after)).toMatchObject({ user_id: U(6), role: 'member', organization_id: ORG_ID })
  })

  it('agents: keep is untouched, relink re-points, disable (delegated and orphaned account) sets disabled_at, each with agent.updated', async () => {
    const { s, before } = await applied()
    for (const n of [1, 4, 5, 6]) expect(await agentRow(n)).toEqual(before.agentsFull.find((a) => a.id === A(n)))
    expect(await agentRow(2)).toMatchObject({
      auth_provider: 'better-auth',
      auth_subject: s.plan.agents.find((a) => a.id === A(2))!.new_auth_user_id,
      disabled_at: null,
    })
    // 3 delegated, 7 account whose Clerk user is gone, 8 account whose Clerk user is no agent
    for (const n of [3, 7, 8]) {
      const r = await agentRow(n)
      expect(r.disabled_at).toBe(NOW.toISOString())
      expect(r.auth_provider).toBe(before.agentsFull.find((a) => a.id === A(n))!.auth_provider) // links are not rewritten
    }
    const updated = await rows(pair.d1, "select * from events where type = 'agent.updated' order by resource_id")
    expect(updated.map((e) => e.resource_id)).toEqual([A(2), A(3), A(7), A(8)])
    const e3 = updated.find((e) => e.resource_id === A(3))!
    expect(JSON.parse(e3.before).disabled_at).toBeNull()
    expect(JSON.parse(e3.after).disabled_at).toBe(NOW.toISOString())
    expect(JSON.parse(e3.after).scopes).toEqual(['contacts:read', 'notes:write'])
  })

  it('every event is the system principal, created now when none existed; ids, api keys and earlier events are unchanged; users re-points emit nothing', async () => {
    const { before, out } = await applied()
    expect(await rows(pair.d1, "select id from principals where kind = 'system'")).toHaveLength(1)
    const system = (await rows(pair.d1, "select id from principals where kind = 'system'"))[0]!.id
    const events = await rows(pair.d1, "select type, actor_id from events where type != 'user.seeded' order by type")
    expect(events.map((e) => e.type)).toEqual([
      'agent.updated',
      'agent.updated',
      'agent.updated',
      'agent.updated',
      'membership.created',
    ])
    for (const e of events) expect(e.actor_id).toBe(system)
    expect(await rows(pair.d1, 'select type from events')).toHaveLength(6) // no event for the four users
    expect((await rows(pair.d1, "select * from events where id = '0190ffff-0000-7000-8000-000000000001'"))[0]).toEqual(
      before.events[0],
    )
    expect(await rows(pair.d1, "select id, kind from principals where kind != 'system' order by id")).toEqual(
      before.principals,
    )
    expect(await rows(pair.d1, 'select id from users order by id')).toEqual(before.users)
    expect(await rows(pair.d1, 'select id from agents order by id')).toEqual(before.agents)
    expect(await rows(pair.control, 'select * from api_keys')).toEqual(before.keys)
    expect(out).toMatchObject({
      users_repointed: 4,
      agents_relinked: 1,
      agents_disabled: 3,
      memberships_inserted: 1,
      control_inserted: 5,
    })
  })

  it('an existing system principal is the actor, and no second one is made', async () => {
    const s = await seed()
    await pair.d1
      .prepare("insert into principals (id, kind, created_at) values (?, 'system', ?)")
      .bind(U(99), '2026-10-01T00:00:00.000Z')
      .run()
    await run(s)
    expect(await rows(pair.d1, "select id from principals where kind = 'system'")).toEqual([{ id: U(99) }])
    expect(new Set((await rows(pair.d1, 'select actor_id from events')).map((e) => e.actor_id))).toEqual(
      new Set([U(99)]),
    )
  })

  it('a plan with no people and no agents writes only the deployment marker (D14; no system principal, no event)', async () => {
    const s = await seed({ users: [], agents: [], memberships: [] })
    const crm = spyD1(pair.d1)
    const out = await run(s, { crm: crm.d1 })
    expect(
      crm.log.statements.filter((q) => WRITE.test(q)).filter((q) => !/^update deployment\b|unit_assertion/.test(q)),
    ).toEqual([])
    expect(await rows(pair.d1, 'select auth_provider from deployment')).toEqual([{ auth_provider: 'better-auth' }])
    expect(await rows(pair.d1, 'select id from events')).toEqual([])
    expect(await rows(pair.d1, 'select id from principals')).toEqual([])
    expect(out).toMatchObject({
      users_repointed: 0,
      agents_relinked: 0,
      agents_disabled: 0,
      memberships_inserted: 0,
      control_inserted: 0,
    })
  })
})

// group 4: all or nothing, and drift.
describe('all or nothing', () => {
  it('a statement that fails mid-batch leaves the CRM exactly as it was, and the control rows stay', async () => {
    const s = await seed()
    const p6 = s.plan.people.find((p) => p.user_id === U(6))!
    let before = ''
    // a Better Auth row for Eve's new id appears between plan and commit: the last user re-point then fails on UNIQUE (auth_provider, auth_subject), after the earlier statements ran
    const fault = faultD1(pair.d1, {
      match: /^update "users"/,
      act: async () => {
        await seedPrincipal(pair.d1, {
          id: U(7),
          kind: 'user',
          email: 'u7@example.test',
          authProvider: 'better-auth',
          authSubject: p6.new_auth_user_id!,
        })
        before = await crmDump()
      },
    })
    const err = await run(s, { crm: fault.d1 }).then(
      () => null,
      (e) => e,
    )
    expect(fault.fired()).toBe(1)
    expect(err).toBeInstanceOf(ApplyFailure)
    expect(exitCodeFor(err)).toBe(EXIT_FAILED_AFTER_WRITE)
    expect(await crmDump()).toEqual(before)
    expect(await rows(pair.d1, 'select id from events')).toEqual([])
    expect(await authUsers()).toHaveLength(5) // inert, kept
  })

  const drifts: Array<[string, () => Promise<void>]> = [
    [
      "a user's subject changed",
      () =>
        pair.d1
          .prepare("update users set auth_subject = 'user_changed' where id = ?")
          .bind(U(1))
          .run()
          .then(() => {}),
    ],
    [
      "an agent's subject changed",
      () =>
        pair.d1
          .prepare("update agents set auth_subject = 'user_changed' where id = ?")
          .bind(A(2))
          .run()
          .then(() => {}),
    ],
    [
      'an agent was disabled',
      () =>
        pair.d1
          .prepare('update agents set disabled_at = ? where id = ?')
          .bind('2026-11-16T23:00:00.000Z', A(3))
          .run()
          .then(() => {}),
    ],
    [
      'a membership was inserted',
      () =>
        pair.d1
          .prepare(
            "insert into memberships (id, created_at, updated_at, organization_id, user_id, role, created_by) values (?, ?, ?, ?, ?, 'member', ?)",
          )
          .bind(
            '0190ffff-0000-7000-8000-0000000000aa',
            '2026-11-16T23:00:00.000Z',
            '2026-11-16T23:00:00.000Z',
            ORG_ID,
            U(6),
            U(1),
          )
          .run()
          .then(() => {}),
    ],
  ]
  for (const [title, change] of drifts) {
    it(`drift: ${title} between the export and the batch aborts the whole unit`, async () => {
      const s = await seed()
      let before = ''
      const fault = faultD1(pair.d1, {
        match: /^update "users"/,
        act: async () => {
          await change()
          before = await crmDump()
        },
      })
      const err = await run(s, { crm: fault.d1 }).then(
        () => null,
        (e) => e,
      )
      expect(fault.fired()).toBe(1)
      expect(err).toBeInstanceOf(ApplyFailure)
      expect((err as Error).message).toMatch(/drift/i)
      expect(await crmDump()).toEqual(before)
      expect(await rows(pair.d1, 'select id from events')).toEqual([])
    })
  }
})

// group 5: partial states and re-runs.
describe('partial states and re-runs', () => {
  it('control written but the CRM batch failed: a re-run is "not applied", inserts no control row, and commits the CRM batch', async () => {
    const s = await seed()
    const boom = faultD1(pair.d1, {
      match: /^update "users"/,
      act: async () => {
        throw new Error('D1 unavailable')
      },
    })
    await expect(run(s, { crm: boom.d1 })).rejects.toBeInstanceOf(ApplyFailure)
    expect(await authUsers()).toHaveLength(5)
    expect(await rows(pair.d1, 'select id from events')).toEqual([])
    const fresh = await readSnapshot(pair.d1, s.clerk) // the CRM is as it was
    expect(assessState(s.plan, fresh)).toBe('not_applied')
    const out = await run(s, { fresh })
    expect(out).toMatchObject({ state: 'not_applied', control_inserted: 0, users_repointed: 4 })
    expect(await rows(pair.d1, "select id from events where type = 'agent.updated'")).toHaveLength(4)
  })

  it('both written: a re-run reports applied and writes nothing', async () => {
    const s = await seed()
    await run(s)
    const fresh = await readSnapshot(pair.d1, s.clerk)
    expect(assessState(s.plan, fresh)).toBe('applied')
    const crm = spyD1(pair.d1)
    const control = spyD1(pair.control)
    const before = [await crmDump(), await controlDump()]
    const out = await run(s, { fresh, crm: crm.d1, control: control.d1 })
    expect(out.state).toBe('applied')
    expect([...crm.log.statements, ...control.log.statements].filter((q) => WRITE.test(q))).toEqual([])
    expect([await crmDump(), await controlDump()]).toEqual(before)
  })

  it('applied, then a Clerk user changed: mismatch', async () => {
    const s = await seed()
    await run(s)
    const fresh = await readSnapshot(pair.d1, s.clerk)
    fresh.clerk_users.find((c) => c.id === 'user_scrubbedb')!.role = 'owner'
    expect(() => assessState(s.plan, fresh)).toThrow(/user_scrubbedb/)
  })

  it('applied, then a vault row changed: mismatch naming the row', async () => {
    const s = await seed()
    await run(s)
    await pair.d1.prepare("update users set name = 'Changed' where id = ?").bind(U(4)).run()
    const fresh = await readSnapshot(pair.d1, s.clerk)
    expect(() => assessState(s.plan, fresh)).toThrow(new RegExp(U(4)))
  })

  it('control rows left by a discarded plan, with a new plan: the taken-email refusal', async () => {
    const s = await seed()
    await applyControlBatch(pair.control, planOf(s.snapshot, 200), NOW)
    await expect(run(s)).rejects.toThrow(/plan file that minted/i)
    expect(await rows(pair.d1, 'select id from events')).toEqual([])
  })
})

// group 6 (module part): what a dry run says.
describe('describePlan', () => {
  it('prints counts per action and no personal data', async () => {
    const s = await seed()
    const text = describePlan(s.plan).join('\n')
    expect(text).toMatch(/5 auth_users rows \(4 people, 1 agent account\)/)
    expect(text).toMatch(/users re-pointed: 4/)
    expect(text).toMatch(/agents relinked: 1/)
    expect(text).toMatch(/agents disabled: 3/)
    expect(text).toMatch(/memberships inserted: 1/)
    expect(text).not.toContain('@example.test')
  })
})
