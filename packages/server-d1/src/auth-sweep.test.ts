import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import {
  MIGRATIONS,
  SWEEP_CONTROL_READ,
  SWEEP_CRM_READ,
  acceptInvitation,
  classifySweep,
  createInvitation,
  openControlDb,
  parseSweepControlRows,
  parseSweepCrmRows,
  recordResetLinkIssued,
  revokeInvitation,
  type D1Like,
  type D1PreparedLike,
} from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { RAIL_CRON, createVibaseRegistry } from '@vibase/api'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import { bootstrapD1, NOW, faultD1, openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE289]] (the repair sweep, [[CORE259]] D10) through the composed Worker's `scheduled` handler on the rail cron: the REAL Better Auth writes the accounts, sessions, tokens and device
// codes on a real control-plane D1 (Miniflare); the CRM is the real migrated D1. Time is real plus a skew the test chooses, because Better Auth stamps its rows with the real clock.
const PASSWORD = 'a long enough password 123'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const declared = createVibaseRegistry().declaredScopes()
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let systemId: string
let otherClient: string
let skew = 0
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  await createMigrationTracker(w.d1)
  await recordMigrations(
    w.d1,
    MIGRATIONS.map((m) => m.name),
  )
  const r = await bootstrapD1(
    w.d1,
    { organizationName: 'Acme', email: 'boot@x.test', agentName: 'bot', authProvider: 'none', authOrgId: 'org_acme' },
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(w.control) },
  )
  orgId = r.organizationId
  bootUser = r.userId!
  systemId = bootUser
  kit = authKit(w.control, { scopes: declared })
  otherClient = await kit.registerClient('Claude Desktop')
  skew = 0
})
afterEach(() => vi.restoreAllMocks())

const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const dump = async (d1: D1Like) => {
  const tables = (
    await rows(
      d1,
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'auth_rate%' and name <> 'auth_jwks'",
    )
  ).map((r) => r.name as string)
  const all: Record<string, unknown[]> = {}
  for (const t of tables) all[t] = await rows(d1, `select * from "${t}" order by 1`)
  return all
}
const iso = (ms: number) => new Date(ms).toISOString()
const control = () => openControlDb(w.control)

type Env = { crm?: D1Like; control?: D1Like }
const worker = (over: Env = {}, clock: () => Date = () => new Date(Date.now() + skew)) =>
  composeD1Worker(
    {
      DB: over.crm ?? w.d1,
      CONTROL_DB: over.control ?? w.control,
      AUTH_PROVIDER: 'better-auth',
      AUTH_SECRET,
      PUBLIC_BASE_URL: AUTH_BASE,
    } as D1WorkerEnv,
    { clock },
  )
const tick = (wk = worker()) => wk.scheduled({ cron: RAIL_CRON })

/** A D1 that runs `act` around the first statement whose SQL equals `sql`: after its `all()` returns, or instead of it (a failed read). */
function hook(real: D1Like, sql: string, h: { after?: () => Promise<void>; fail?: boolean }): D1Like {
  let fired = false
  const inner = new WeakMap<object, D1PreparedLike>()
  const wrap = (query: string, p: D1PreparedLike): D1PreparedLike => {
    const w = {
      bind: (...v: unknown[]) => wrap(query, p.bind(...v)),
      run: () => p.run(),
      first: () => p.first(),
      all: async () => {
        if (query !== sql || fired) return p.all()
        fired = true
        if (h.fail) throw new Error('D1 is unavailable')
        const r = await p.all()
        await h.after?.()
        return r
      },
    } as D1PreparedLike
    inner.set(w, p)
    return w
  }
  // The platform's own batch takes the real statements, so the wrappers are unwrapped first.
  return {
    prepare: (q: string) => wrap(q, real.prepare(q)),
    batch: (b: D1PreparedLike[]) => real.batch(b.map((s) => inner.get(s) ?? s)),
  }
}

interface Account {
  subject: string
  email: string
  cookie: string
}
let seq = 0
/** A Better Auth account with a session, OAuth tokens (access and refresh) and a pending device code: every kind of credential the sweep revokes. */
async function account(email: string, withTokens = true): Promise<Account> {
  const { userId, cookie } = await kit.signUp(email)
  if (withTokens) {
    await kit.deviceTokens(cookie, otherClient, 'openid offline_access contacts:read')
    // An opaque access-token row (the grant above issues a JWT without one).
    const t = iso(Date.now())
    await w.control
      .prepare(
        'insert into auth_oauth_access_tokens (id, token, client_id, user_id, expires_at, created_at, scopes) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(`at${++seq}`, `acc${seq}`, otherClient, userId, iso(Date.now() + DAY), t, 'openid')
      .run()
  }
  await w.control
    .prepare(
      'insert into auth_device_codes (id, device_code, user_code, user_id, expires_at, status) values (?, ?, ?, ?, ?, ?)',
    )
    .bind(`dc${++seq}`, `dev${seq}`, `usr${seq}`, userId, iso(Date.now() + DAY), 'pending')
    .run()
  return { subject: userId, email, cookie }
}
const CRED_TABLES = ['auth_sessions', 'auth_oauth_refresh_tokens', 'auth_oauth_access_tokens', 'auth_device_codes']
const credentials = async (subject: string) => {
  const out: Record<string, unknown[]> = {}
  for (const t of CRED_TABLES)
    out[t] = await rows(w.control, `select * from ${t} where user_id = ? order by id`, subject)
  return out
}
const credentialCount = async (subject: string) =>
  Object.values(await credentials(subject)).reduce((n, r) => n + r.length, 0)

/** A linked human: a CRM user with the Better Auth subject, a membership when `live`. */
async function link(a: Account, role: 'owner' | 'member', o: { live?: boolean } = {}) {
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email: a.email, authProvider: 'better-auth', authSubject: a.subject })
  if (o.live !== false) await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return id
}
async function linkAgent(a: Account, o: { disabled?: boolean } = {}) {
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read'] })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ?, disabled_at = ? where id = ?')
    .bind('better-auth', a.subject, o.disabled ? '2026-10-27T10:00:00.000Z' : null, id)
    .run()
  return id
}
const createdAt = async (subject: string) =>
  Date.parse((await rows(w.control, 'select created_at from auth_users where id = ?', subject))[0]!.created_at)
const audits = async () => rows(w.control, 'select * from control_audit order by id')
const sha = (n: string) => n.padEnd(64, '0')
/** A control-plane invitation at an exact created_at, with the state a test needs. */
async function invitation(email: string, o: { at: number; expiresAt?: number; state?: 'revoked' | 'accepted' }) {
  const id = uuidv7()
  expect(
    await createInvitation(control(), {
      id,
      auditId: uuidv7(),
      organizationId: orgId,
      email,
      role: 'member',
      tokenHash: sha(id.replace(/-/g, '')),
      expiresAt: iso(o.expiresAt ?? o.at + 7 * DAY),
      createdBy: systemId,
      now: iso(o.at),
    }),
  ).toBe('created')
  if (o.state === 'revoked')
    await revokeInvitation(control(), { id, auditId: uuidv7(), actorId: systemId, now: iso(o.at + 1) })
  if (o.state === 'accepted')
    expect(await acceptInvitation(control(), { id, auditId: uuidv7(), actorId: systemId, now: iso(o.at + 2) })).toBe(
      'accepted',
    )
  return id
}
const present = async (subject: string) =>
  (await rows(w.control, 'select id from auth_users where id = ?', subject)).length === 1
const sweepLog = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => /auth sweep/.test(l))

describe('P1 revocation by subject kind (the matrix)', () => {
  it('only linked subjects without authority lose sessions, refresh tokens, access-token rows and device codes; nobody else changes by a byte; a second tick writes nothing', async () => {
    const live = await account('live@x.test')
    const owner = await account('owner@x.test')
    const removed = await account('removed@x.test')
    const enabledAgent = await account('agent-on@x.test')
    const disabledAgent = await account('agent-off@x.test')
    const bare = await account('bare@x.test')
    const young = await account('young@x.test')
    await link(live, 'member')
    await link(owner, 'owner')
    await link(removed, 'member', { live: false })
    await linkAgent(enabledAgent)
    await linkAgent(disabledAgent, { disabled: true })
    await link(bare, 'member', { live: false })
    // `bare` has a users row and no membership at all; `removed` had one and lost it.
    await w.d1
      .prepare("update memberships set deleted_at = '2026-10-27T10:00:00.000Z' where user_id = ?")
      .bind(bootUser)
      .run()
    const crmBefore = await dump(w.d1)
    const auditBefore = await audits()
    const keep = [live, owner, enabledAgent, young]
    const gone = [removed, disabledAgent, bare]
    const before = new Map<string, Record<string, unknown[]>>()
    for (const a of [...keep, ...gone]) {
      before.set(a.subject, await credentials(a.subject))
      expect(await credentialCount(a.subject), a.email).toBeGreaterThanOrEqual(4)
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await tick()
    for (const a of gone)
      expect(await credentials(a.subject), a.email).toEqual({
        auth_sessions: [],
        auth_oauth_refresh_tokens: [],
        auth_oauth_access_tokens: [],
        auth_device_codes: [],
      })
    for (const a of keep) expect(await credentials(a.subject), a.email).toEqual(before.get(a.subject))
    // Consents, accounts and the users rows stay.
    for (const a of gone) expect(await present(a.subject)).toBe(true)
    expect((await rows(w.control, 'select id from auth_accounts where user_id = ?', removed.subject)).length).toBe(1)
    expect(sweepLog(log)).toEqual([expect.stringContaining('revoked 3 subject(s), deleted 0 account(s)')])
    // P4: no audit row, no CRM change.
    expect(await audits()).toEqual(auditBefore)
    expect(await dump(w.d1)).toEqual(crmBefore)
    // A second tick writes nothing at all.
    const controlAfter = await dump(w.control)
    log.mockClear()
    await tick()
    expect(await dump(w.control)).toEqual(controlAfter)
    expect(sweepLog(log)).toEqual([])
  })

  it('more than 100 linked subjects without authority are all revoked (the 100-parameter cap)', async () => {
    const ids: string[] = []
    const t = iso(Date.now() - HOUR)
    for (let i = 0; i < 130; i++) {
      const id = `bulk-${String(i).padStart(3, '0')}`
      ids.push(id)
      await w.control
        .prepare(
          'insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)',
        )
        .bind(id, 'B', `bulk${i}@x.test`, t, t)
        .run()
      await w.control
        .prepare(
          'insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values (?, ?, ?, ?, ?, ?)',
        )
        .bind(`bs${i}`, iso(Date.now() + DAY), `tok${i}`, t, t, id)
        .run()
      const pid = uuidv7(NOW)
      await seedPrincipal(w.d1, {
        id: pid,
        kind: 'user',
        email: `bulk${i}@x.test`,
        authProvider: 'better-auth',
        authSubject: id,
      })
    }
    await tick()
    expect(
      Number((await rows(w.control, "select count(*) n from auth_sessions where user_id like 'bulk-%'"))[0]!.n),
    ).toBe(0)
  })
})

describe('P2 orphan deletion', () => {
  const sweepAt = (at: number) => tick(worker({}, () => new Date(at)))

  it('an unlinked account at 24 h + 1 ms is deleted with every control row that names it (every auth table with a user column, read from the schema); kept at 24 h - 1 ms and at exactly 24 h', async () => {
    const o = await account('orphan@x.test')
    const at = await createdAt(o.subject)
    // Seed a row for every other table that holds a user column, found by reading the schema, so a table added later cannot slip by.
    await w.control
      .prepare(
        'insert into auth_oauth_consents (id, client_id, user_id, scopes, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
      )
      .bind('consent1', otherClient, o.subject, 'openid', iso(at), iso(at))
      .run()
    await w.control
      .prepare('insert into auth_oauth_clients (id, client_id, user_id, redirect_uris) values (?, ?, ?, ?)')
      .bind('oc1', 'owned-client', o.subject, '[]')
      .run()
    const userTables = (
      await rows(
        w.control,
        "select m.name as t from sqlite_master m, pragma_table_info(m.name) c where m.type = 'table' and m.name like 'auth\\_%' escape '\\' and c.name = 'user_id'",
      )
    ).map((r) => r.t as string)
    expect(userTables.length).toBeGreaterThanOrEqual(7)
    for (const t of userTables)
      expect(
        Number((await rows(w.control, `select count(*) n from ${t} where user_id = ?`, o.subject))[0]!.n),
        `${t} seeded`,
      ).toBeGreaterThan(0)
    const resetAudit = uuidv7()
    await recordResetLinkIssued(control(), {
      auditId: resetAudit,
      actorId: systemId,
      subject: o.subject,
      expiresAt: iso(at + HOUR),
      now: iso(at),
    })

    await sweepAt(at + DAY - 1)
    expect(await present(o.subject)).toBe(true)
    await sweepAt(at + DAY)
    expect(await present(o.subject)).toBe(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await sweepAt(at + DAY + 1)
    expect(await present(o.subject)).toBe(false)
    for (const t of userTables)
      expect(
        Number((await rows(w.control, `select count(*) n from ${t} where user_id = ?`, o.subject))[0]!.n),
        `${t} cleaned`,
      ).toBe(0)
    expect(sweepLog(log)).toEqual([expect.stringContaining('revoked 0 subject(s), deleted 1 account(s)')])
    // control_audit rows that target it stay, and the sweep wrote none.
    expect((await audits()).filter((a) => a.target_id === o.subject).map((a) => a.id)).toEqual([resetAudit])
  })

  it('kept with a live invitation created before it, with an accepted one, and when linked; an invitation created after the account, a revoked one and an expired one do not keep it', async () => {
    const liveInv = await account('live-inv@x.test', false)
    const acceptedInv = await account('accepted-inv@x.test', false)
    const linked = await account('linked@x.test', false)
    const later = await account('later@x.test', false)
    const revoked = await account('revoked@x.test', false)
    const expired = await account('expired@x.test', false)
    const none = await account('none@x.test', false)
    await link(linked, 'member')
    const at = await createdAt(none.subject)
    const t = (
      await Promise.all([liveInv, acceptedInv, linked, later, revoked, expired].map((a) => createdAt(a.subject)))
    ).reduce((m, x) => Math.max(m, x), at)
    await invitation(liveInv.email, { at: (await createdAt(liveInv.subject)) - 60_000, expiresAt: t + 30 * DAY })
    await invitation(acceptedInv.email, { at: (await createdAt(acceptedInv.subject)) - 60_000, state: 'accepted' })
    await invitation(later.email, { at: (await createdAt(later.subject)) + HOUR, expiresAt: t + 30 * DAY })
    await invitation(revoked.email, { at: (await createdAt(revoked.subject)) - 60_000, state: 'revoked' })
    await invitation(expired.email, { at: (await createdAt(expired.subject)) - 60_000, expiresAt: t + 2 * HOUR })
    await tick(worker({}, () => new Date(t + DAY + HOUR * 3)))
    expect(
      await Promise.all([liveInv, acceptedInv, linked, later, revoked, expired, none].map((a) => present(a.subject))),
    ).toEqual([true, true, true, false, false, false, false])
  })

  it('the empty state: no invitation rows and no linked CRM users, a stale orphan is deleted and an empty tick writes nothing', async () => {
    expect((await rows(w.control, 'select 1 from invitations')).length).toBe(0)
    const before = await dump(w.control)
    await tick()
    expect(await dump(w.control)).toEqual(before)
    const o = await account('lonely@x.test', false)
    await sweepAt((await createdAt(o.subject)) + DAY + 5)
    expect(await present(o.subject)).toBe(false)
  })
})

describe('P3 races and partial states', () => {
  it('(a) a session created after the CRM read survives the revocation of its subject', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    const crm = hook(w.d1, SWEEP_CRM_READ, {
      after: async () =>
        void (await kit
          .call('/auth/sign-in/email', { body: { email: gone.email, password: PASSWORD } })
          .then((r) => r.text())),
    })
    const old = (await credentials(gone.subject)).auth_sessions.map((s: any) => s.id as string)
    await tick(worker({ crm }))
    const left = (await rows(w.control, 'select id from auth_sessions where user_id = ?', gone.subject)).map(
      (r) => r.id as string,
    )
    expect(left.length).toBe(1)
    expect(old).not.toContain(left[0])
    // The next tick (CRM unchanged) removes it.
    await tick()
    expect(await credentialCount(gone.subject)).toBe(0)
  })

  it('(b) an acceptance completing between the CRM read and the delete keeps the account', async () => {
    const o = await account('racing@x.test', false)
    const at = await createdAt(o.subject)
    const inv = await invitation(o.email, { at: at - 60_000, expiresAt: at + HOUR })
    const crm = hook(w.d1, SWEEP_CRM_READ, {
      after: async () => {
        // The acceptance: the CRM link appears and the invitation is marked accepted (it had expired by the sweep's clock only).
        await seedPrincipal(w.d1, {
          id: uuidv7(NOW),
          kind: 'user',
          email: o.email,
          authProvider: 'better-auth',
          authSubject: o.subject,
        })
        await w.control
          .prepare('update invitations set accepted_at = ? where id = ?')
          .bind(iso(at + 30 * 60_000), inv)
          .run()
      },
    })
    await tick(worker({ crm }, () => new Date(at + 2 * DAY)))
    expect(await present(o.subject)).toBe(true)
  })

  it('a failing CRM read writes nothing; the next tick completes the work', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    const orphan = await account('orphan@x.test', false)
    const clock = () => new Date(Date.now() + 2 * DAY)
    const before = await dump(w.control)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(tick(worker({ crm: hook(w.d1, SWEEP_CRM_READ, { fail: true }) }, clock))).rejects.toThrow(
      'D1 is unavailable',
    )
    expect(await dump(w.control)).toEqual(before)
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/auth sweep failed: Error/)
    await tick(worker({}, clock))
    expect(await credentialCount(gone.subject)).toBe(0)
    expect(await present(orphan.subject)).toBe(false)
  })

  it('a failing control batch writes nothing; the next tick completes the work', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    const before = await dump(w.control)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fault = faultD1(w.control, {
      match: /delete from auth_/i,
      act: async () => {
        throw new Error('D1 is unavailable')
      },
    })
    await expect(tick(worker({ control: fault.d1 }))).rejects.toThrow('D1 is unavailable')
    expect(fault.fired()).toBe(1)
    expect(await dump(w.control)).toEqual(before)
    await tick()
    expect(await credentialCount(gone.subject)).toBe(0)
  })
})

describe('P4, P5 cron wiring and isolation', () => {
  it('on better-auth the rail cron runs the sweep and logs one [cron] line with its counts; a tick with nothing to do writes nothing and logs nothing', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await tick()
    expect(sweepLog(log)).toEqual([`[cron] ${RAIL_CRON}: auth sweep revoked 1 subject(s), deleted 0 account(s)`])
    log.mockClear()
    await tick()
    expect(sweepLog(log)).toEqual([])
  })

  it('other cron expressions never run it', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await worker().scheduled({ cron: '*/15 * * * *' })
    expect(await credentialCount(gone.subject)).toBeGreaterThan(0)
  })

  it('without a control store (a provider other than better-auth) the sweep issues no control read', async () => {
    const touched: string[] = []
    const spy: D1Like = {
      prepare: (q) => (touched.push(q), w.control.prepare(q)),
      batch: (b) => (touched.push('batch'), w.control.batch(b)),
    }
    const wk = composeD1Worker({ DB: w.d1, CONTROL_DB: spy, AUTH_PROVIDER: '' } as D1WorkerEnv, {
      clock: () => new Date(),
    })
    await tick(wk)
    // [[CORE337]] P2: the tick's webhook gate asks the control database (its migration state and marker) on every provider; the SWEEP's reads (the auth tables) are what this case is about.
    expect(touched.filter((q) => /\bauth_/.test(q))).toEqual([])
  })

  it('an injected sweep failure still lets the rail work run, and a rail failure still lets the sweep run', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(tick(worker({ crm: hook(w.d1, SWEEP_CRM_READ, { fail: true }) }))).rejects.toThrow()
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/rail expired 0 request\(s\)/)
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/webhooks dispatched/)
    expect(await credentialCount(gone.subject)).toBeGreaterThan(0)
    // The reverse: the rail's own queries fail, the sweep still revokes.
    log.mockClear()
    err.mockClear()
    const railFails: D1Like = {
      prepare: (q) =>
        /from "?action_requests"?|update "?action_requests"?/i.test(q)
          ? (() => {
              throw new Error('rail down')
            })()
          : w.d1.prepare(q),
      batch: (b) => w.d1.batch(b),
    }
    await expect(tick(worker({ crm: railFails }))).rejects.toThrow('rail down')
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/failed: Error/)
    expect(await credentialCount(gone.subject)).toBe(0)
  })
})

describe('D9 repairs end to end', () => {
  const owner = async () => {
    const a = await account('owner@x.test', false)
    await link(a, 'owner')
    return a
  }
  const PATH = '/meta/v1/memberships'
  const call = (wk: ReturnType<typeof worker>, method: string, path: string, tok: string) =>
    wk.fetch(
      new Request(AUTH_BASE + path, {
        method,
        headers: { authorization: `Bearer ${tok}`, 'cf-connecting-ip': '198.51.100.7' },
      }),
    )

  it('CORE288: a removal whose control batch failed leaves sessions that one tick removes', async () => {
    const o = await owner()
    const gone = await account('gone@x.test')
    const id = await link(gone, 'member')
    const memberRow = (await rows(w.d1, 'select id from memberships where user_id = ?', id))[0]!.id as string
    const fault = faultD1(w.control, {
      match: /delete from auth_/i,
      act: async () => {
        throw new Error('D1 is unavailable')
      },
    })
    const res = await call(
      worker({ control: fault.d1 }),
      'DELETE',
      `${PATH}/${memberRow}`,
      await kit.sessionJwt(o.cookie),
    )
    expect(res.status).toBe(200)
    expect(fault.fired()).toBe(1)
    expect(await credentialCount(gone.subject)).toBeGreaterThanOrEqual(4)
    await tick()
    expect(await credentialCount(gone.subject)).toBe(0)
  })

  it('CORE287: an acceptance crashed after the account was created is kept while its invitation is live (the next sign-in repairs) and deleted one tick after 24 h once the invitation is revoked or expired', async () => {
    const accepts = (email: string) => {
      const orphan = async (state?: 'revoked') => {
        const o = await account(email, false)
        const at = await createdAt(o.subject)
        const inv = await invitation(email, { at: at - 60_000, expiresAt: at + 10 * DAY, ...(state ? { state } : {}) })
        return { o, at, inv }
      }
      return orphan
    }
    // Live invitation: kept at 25 h, and the sign-in then repairs it (the CRM program runs, the invitation is accepted).
    const a = await accepts('crashed@x.test')()
    await tick(worker({}, () => new Date(a.at + 25 * HOUR)))
    expect(await present(a.o.subject)).toBe(true)
    expect((await rows(w.d1, 'select id from users where auth_subject = ?', a.o.subject)).length).toBe(0)
    expect(
      (
        await worker().fetch(
          new Request(AUTH_BASE + '/auth/sign-in/email', {
            method: 'POST',
            headers: { origin: AUTH_BASE, 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
            body: JSON.stringify({ email: a.o.email, password: PASSWORD }),
          }),
        )
      ).status,
    ).toBe(200)
    expect((await rows(w.d1, 'select id from users where auth_subject = ?', a.o.subject)).length).toBe(1)
    expect(
      (await rows(w.control, 'select accepted_at from invitations where id = ?', a.inv))[0]!.accepted_at,
    ).not.toBeNull()
    // Revoked: deleted one tick after 24 h. Expired: likewise.
    const r = await accepts('revoked-crash@x.test')('revoked')
    const e = await account('expired-crash@x.test', false)
    const eat = await createdAt(e.subject)
    await invitation(e.email, { at: eat - 60_000, expiresAt: eat + 2 * HOUR })
    await tick(worker({}, () => new Date(Math.max(r.at, eat) + 25 * HOUR)))
    expect(await present(r.o.subject)).toBe(false)
    expect(await present(e.subject)).toBe(false)
  })
})

describe('the shared classifier equals what a tick acts on (P6 source)', () => {
  it('counts classified from the SAME statements, run on both databases, equal what one tick then deletes', async () => {
    const gone = await account('gone@x.test')
    await link(gone, 'member', { live: false })
    const live = await account('live@x.test')
    await link(live, 'member')
    const o = await account('orphan@x.test', false)
    const young = await account('young@x.test', false)
    const at = await createdAt(o.subject)
    const now = iso(Math.max(at, await createdAt(young.subject)) + 2 * DAY)
    const control = parseSweepControlRows((await rows(w.control, SWEEP_CONTROL_READ)) as never)
    const crm = parseSweepCrmRows((await rows(w.d1, SWEEP_CRM_READ)) as never)
    const plan = classifySweep({ now, control, crm })
    expect(plan.revoke).toEqual([gone.subject])
    expect(plan.orphans.sort()).toEqual([o.subject, young.subject].sort())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await tick(worker({}, () => new Date(now)))
    expect(sweepLog(log)).toEqual([
      `[cron] ${RAIL_CRON}: auth sweep revoked ${plan.revoke.length} subject(s), deleted ${plan.orphans.length} account(s)`,
    ])
  })
})
