import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createMigrationTracker, recordMigrations } from '@vibase/storage-d1/test'
import {
  MIGRATIONS,
  createInvitation,
  openControlDb,
  revokeInvitation,
  type D1Like,
  type D1PreparedLike,
} from '@vibase/storage-d1'
import { seedAgent, seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { SCOPE_POLICY, assertAgentGrantable, createVibaseRegistry, grantableScopes, scopesForRole } from '@vibase/api'
import { mintClerkToken } from '@vibase/api/test/clerk'
import { type D1WorkerEnv } from './compose.js'
import { AUTH_BASE, AUTH_SECRET, authKit, type AuthKit } from './test/auth-kit.js'
import {
  bootstrapD1,
  unauditedControl,
  NOW,
  clerkKit,
  clerkUser,
  openWorkerD1,
  openWorkerPair,
  type ClerkKit,
  type WorkerPair,
  composeD1Worker,
} from './test/kit.js'

// [[CORE245]] P1-P6 through the composition: the REAL Better Auth mints the tokens on the control-plane database, the Worker (composeD1Worker, `better-auth`) serves the three invitation operations
// on REST and MCP, and every write lands in `CONTROL_DB` with its `control_audit` row.
let w: WorkerPair
let kit: AuthKit
let orgId: string
let bootUser: string
let bootKey: string
let otherClient: string
const declared = createVibaseRegistry().declaredScopes()
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
    { now: NOW, newId: () => uuidv7(NOW), control: openControlDb(unauditedControl(w.control)) },
  )
  orgId = r.organizationId
  bootUser = r.userId!
  bootKey = r.key
  kit = authKit(w.control, { scopes: declared })
  otherClient = await kit.registerClient('Claude Desktop')
})

const worker = (control: D1WorkerEnv['CONTROL_DB'] = w.control) =>
  composeD1Worker({
    DB: w.d1,
    CONTROL_DB: control,
    AUTH_PROVIDER: 'better-auth',
    AUTH_SECRET,
    PUBLIC_BASE_URL: AUTH_BASE,
  })
type Res = { status: number; json: any }
const call = async (
  wk: ReturnType<typeof worker>,
  method: string,
  path: string,
  tok: string | null,
  body?: unknown,
): Promise<Res> => {
  const res = await wk.fetch(
    new Request(AUTH_BASE + path, {
      method,
      headers: {
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, '')
const dump = async (d1: D1Like) => {
  const tables = (
    await rows(
      d1,
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'",
    )
  ).map((r) => r.name as string)
  const all: Record<string, unknown[]> = {}
  for (const t of tables) all[t] = await rows(d1, `select * from "${t}"`)
  return all
}
const crmCounts = async () =>
  Object.fromEntries(
    await Promise.all(
      ['events', 'users', 'principals', 'agents', 'memberships', 'organizations'].map(async (t) => [
        t,
        (await rows(w.d1, `select count(*) n from "${t}"`))[0]!.n as number,
      ]),
    ),
  )

async function human(role: 'owner' | 'member', email = `${role}@x.test`) {
  const { userId, cookie } = await kit.signUp(email)
  const id = uuidv7(NOW)
  await seedPrincipal(w.d1, { id, kind: 'user', email, authProvider: 'better-auth', authSubject: userId })
  await seedMembership(w.d1, { organizationId: orgId, userId: id, role })
  return {
    id,
    cookie,
    session: () => kit.sessionJwt(cookie),
    oauth: async (client: string, scope = 'openid contacts:read') =>
      (await kit.deviceTokens(cookie, client, scope)).access_token,
  }
}
async function agentAccount() {
  const { userId, cookie } = await kit.signUp('agent-account@x.test')
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read', 'contacts:write'] })
  await w.d1
    .prepare('update agents set auth_provider = ?, auth_subject = ? where id = ?')
    .bind('better-auth', userId, id)
    .run()
  return { session: () => kit.sessionJwt(cookie) }
}

/** An agent of the organisation in the CRM (AGT701 D13): `agents create`'s shape, no credential. */
async function seedCrmAgent(kind: 'plain' | 'form' | 'delegated' | 'disabled' | 'has_account' = 'plain') {
  const id = uuidv7(NOW)
  await seedAgent(w.d1, { id, organizationId: orgId, createdBy: bootUser, scopes: ['contacts:read'] })
  if (kind === 'form')
    await w.d1
      .prepare(
        `insert into forms (id, created_at, updated_at, organization_id, created_by, name, public_id, enabled, email_field, name_field) values (?, ?, ?, ?, ?, 'Site', 'frm_aaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'email', 'name')`,
      )
      .bind(id, NOW.toISOString(), NOW.toISOString(), orgId, id)
      .run()
  if (kind === 'delegated')
    await w.d1
      .prepare(
        "update agents set auth_provider = 'better-auth', auth_client_id = 'dcr-client', delegated_by = ? where id = ?",
      )
      .bind(bootUser, id)
      .run()
  if (kind === 'disabled')
    await w.d1.prepare('update agents set disabled_at = ? where id = ?').bind(NOW.toISOString(), id).run()
  if (kind === 'has_account')
    await w.d1
      .prepare("update agents set auth_provider = 'better-auth', auth_subject = 'subject-1' where id = ?")
      .bind(id)
      .run()
  return id
}

const PATH = '/meta/v1/invitations'
const create = (wk: ReturnType<typeof worker>, tok: string, body: unknown = { email: 'ann@x.test', role: 'member' }) =>
  call(wk, 'POST', PATH, tok, body)
const iso = (ms: number) => new Date(ms).toISOString()
const DAY = 86_400_000
/** A control-plane invitation written through the store at a chosen clock: pending, expired, revoked or accepted (the last by a direct write: no acceptance path exists yet). */
async function seed(
  email: string,
  state: 'pending' | 'expired' | 'revoked' | 'accepted',
  role: 'owner' | 'member' | 'agent' = 'member',
  agentId?: string,
) {
  const c = openControlDb(w.control)
  const t = Date.now()
  const id = uuidv7(NOW)
  const hash = sha256(`${id}-${email}`)
  const now = state === 'expired' ? iso(t - 9 * DAY) : iso(t - 1000)
  expect(
    await createInvitation(c, {
      id,
      auditId: uuidv7(NOW),
      organizationId: orgId,
      email,
      role,
      ...(agentId === undefined ? {} : { agentId }),
      tokenHash: hash,
      expiresAt: state === 'expired' ? iso(t - 2 * DAY) : iso(t + 7 * DAY),
      createdBy: bootUser,
      now,
    }),
  ).toBe('created')
  if (state === 'revoked') await revokeInvitation(c, { id, auditId: uuidv7(NOW), actorId: bootUser, now: iso(t - 500) })
  if (state === 'accepted')
    await w.control
      .prepare('update invitations set accepted_at = ? where id = ?')
      .bind(iso(t - 500), id)
      .run()
  return id
}

describe('create (P2, P3, P4)', () => {
  it('returns the URL once, stores only the token hash, and nothing else holds the token', async () => {
    const owner = await human('owner')
    const wk = worker()
    const before = Date.now()
    const res = await create(wk, await owner.session(), { email: 'Ann@X.test', role: 'member' })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(Object.keys(res.json).sort()).toEqual(['agent_id', 'delivery', 'email', 'expires_at', 'id', 'role', 'url'])
    expect(res.json.agent_id).toBeNull()
    expect(res.json).toMatchObject({ email: 'ann@x.test', role: 'member' })
    const url = new URL(res.json.url)
    expect(url.origin + url.pathname).toBe(`${AUTH_BASE}/app/invite`)
    const token = tokenOf(res.json.url)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [row] = await rows(w.control, 'select * from invitations where id = ?', res.json.id)
    expect(row).toMatchObject({
      organization_id: orgId,
      email: 'ann@x.test',
      role: 'member',
      token_hash: sha256(token),
      created_by: owner.id,
      accepted_at: null,
      revoked_at: null,
    })
    expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBe(7 * DAY)
    expect(Date.parse(row!.created_at)).toBeGreaterThanOrEqual(before)
    expect(res.json.expires_at).toBe(row!.expires_at)
    // the token is in no row of either database, and not in any later answer
    for (const d1 of [w.control, w.d1]) expect(JSON.stringify(await dump(d1))).not.toContain(token)
    const listed = await call(wk, 'GET', PATH, await owner.session())
    expect(JSON.stringify(listed.json)).not.toContain(token)
    expect(JSON.stringify(listed.json)).not.toContain(sha256(token))
    expect(JSON.stringify(listed.json)).not.toContain('/app/invite')
  })

  it('writes one invitation.created audit row naming the creator, with detail free of the token and its hash', async () => {
    const owner = await human('owner')
    const agentId = await seedCrmAgent()
    const res = await create(worker(), await owner.session(), { email: 'audit@x.test', agent_id: agentId })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const audit = await rows(w.control, 'select * from control_audit where target_id = ?', res.json.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: owner.id, action: 'invitation.created', target_type: 'invitation' })
    expect(JSON.parse(audit[0]!.detail)).toEqual({
      email: 'audit@x.test',
      role: 'agent',
      expires_at: res.json.expires_at,
      delivery: 'link',
      agent_id: agentId,
    })
    const token = tokenOf(res.json.url)
    expect(audit[0]!.detail).not.toContain(token)
    expect(audit[0]!.detail).not.toContain(sha256(token))
  })

  it('normalises the address and validates the role and the address', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    expect((await create(wk, tok, { email: '  Mixed.Case@Example.COM ', role: 'owner' })).json).toMatchObject({
      email: 'mixed.case@example.com',
      role: 'owner',
    })
    for (const bad of [
      { email: 'a@x.test', role: 'admin' },
      { email: 'a@x.test' },
      { role: 'member' },
      { email: 'not-an-address', role: 'member' },
      { email: '', role: 'member' },
      { email: 'a@x.test', role: 'member', extra: 1 },
    ]) {
      const res = await create(wk, tok, bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(res.json.error.code).toBe('validation_error')
    }
    expect(await rows(w.control, 'select id from invitations')).toHaveLength(1)
  })

  it('a second live invitation for the same address (in another case) is 409 and writes nothing; after a revoke or an expiry a new one is created', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    const first = await create(wk, tok)
    expect(first.status).toBe(201)
    const auditBefore = (await rows(w.control, 'select id from control_audit')).length
    const dup = await create(wk, tok, { email: 'ANN@x.test', role: 'owner' })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe('invitation_exists')
    expect(await rows(w.control, 'select id from invitations')).toHaveLength(1)
    expect(await rows(w.control, 'select id from control_audit')).toHaveLength(auditBefore)
    expect((await call(wk, 'POST', `${PATH}/${first.json.id}/revoke`, tok)).status).toBe(200)
    expect((await create(wk, tok)).status).toBe(201)
    // expiry by the clock: a lapsed live invitation does not block
    await seed('lapsed@x.test', 'expired')
    expect((await create(wk, tok, { email: 'lapsed@x.test', role: 'member' })).status).toBe(201)
  })

  it('the first invitation of an empty state is created', async () => {
    const owner = await human('owner')
    expect(await rows(w.control, 'select id from invitations')).toEqual([])
    expect((await create(worker(), await owner.session())).status).toBe(201)
  })
})

describe('an agent invitation names an existing agent (AGT701 D13)', () => {
  const makeBody = (agentId: string, extra: Record<string, unknown> = {}) => ({
    email: 'agent@x.test',
    agent_id: agentId,
    ...extra,
  })
  const counts = async () => ({
    invitations: (await rows(w.control, 'select id from invitations')).length,
    audit: (await rows(w.control, 'select id from control_audit')).length,
  })

  it('agent_id alone creates an agent invitation: role agent stored and answered, agent_id answered and stored', async () => {
    const owner = await human('owner')
    const agentId = await seedCrmAgent()
    const res = await create(worker(), await owner.session(), makeBody(agentId))
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json).toMatchObject({ email: 'agent@x.test', role: 'agent', agent_id: agentId })
    expect(await rows(w.control, 'select role, agent_id from invitations where id = ?', res.json.id)).toEqual([
      { role: 'agent', agent_id: agentId },
    ])
  })

  it('role agent beside agent_id is accepted', async () => {
    const owner = await human('owner')
    const agentId = await seedCrmAgent()
    const res = await create(worker(), await owner.session(), makeBody(agentId, { role: 'agent' }))
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.role).toBe('agent')
  })

  for (const role of ['owner', 'member']) {
    it(`role ${role} beside agent_id is 400 validation_error and writes nothing`, async () => {
      const owner = await human('owner')
      const agentId = await seedCrmAgent()
      const before = await counts()
      const res = await create(worker(), await owner.session(), makeBody(agentId, { role }))
      expect(res.status).toBe(400)
      expect(res.json.error.code).toBe('validation_error')
      expect(await counts()).toEqual(before)
    })
  }

  it('role agent without agent_id is 400 agent_id_required with the spec message, and writes nothing', async () => {
    const owner = await human('owner')
    const before = await counts()
    const res = await create(worker(), await owner.session(), { email: 'agent@x.test', role: 'agent' })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('agent_id_required')
    expect(res.json.error.message).toBe(
      'create the agent with `vibase agents create`, then invite it with its `agent_id`',
    )
    expect(await counts()).toEqual(before)
  })

  it('without agent_id, role stays required; a malformed agent_id is 400', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    expect((await create(worker(), tok, { email: 'agent@x.test' })).json.error.code).toBe('validation_error')
    expect((await create(worker(), tok, makeBody('not-a-uuid'))).status).toBe(400)
  })

  // The agent states, in the spec's order (404, 409 form_principal, delegated_agent, agent_disabled, agent_has_account); each refusal writes nothing.
  const states: Array<[string, () => Promise<string>, number, string]> = [
    ['an unknown agent', async () => uuidv7(NOW), 404, 'not_found'],
    ['a form agent', () => seedCrmAgent('form'), 409, 'form_principal'],
    ['a delegated agent', () => seedCrmAgent('delegated'), 409, 'delegated_agent'],
    ['a disabled agent', () => seedCrmAgent('disabled'), 409, 'agent_disabled'],
    ['an agent that already has an account', () => seedCrmAgent('has_account'), 409, 'agent_has_account'],
  ]
  for (const [label, seedState, status, code] of states) {
    it(`${label}: ${status} ${code}, no invitation and no audit row`, async () => {
      const owner = await human('owner')
      const agentId = await seedState()
      const before = await counts()
      const res = await create(worker(), await owner.session(), makeBody(agentId))
      expect(res.status, JSON.stringify(res.json)).toBe(status)
      expect(res.json.error.code).toBe(code)
      expect(await counts()).toEqual(before)
    })
  }

  it('the refusals are decided in order: a form agent that is also disabled and linked is form_principal; a delegated one that is disabled is delegated_agent; a disabled linked one is agent_disabled', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const both = async (id: string) => {
      await w.d1.prepare('update agents set disabled_at = ? where id = ?').bind(NOW.toISOString(), id).run()
    }
    const form = await seedCrmAgent('form')
    await both(form)
    expect((await create(worker(), tok, makeBody(form))).json.error.code).toBe('form_principal')
    const delegated = await seedCrmAgent('delegated')
    await both(delegated)
    expect((await create(worker(), tok, makeBody(delegated))).json.error.code).toBe('delegated_agent')
    const linked = await seedCrmAgent('has_account')
    await both(linked)
    expect((await create(worker(), tok, makeBody(linked))).json.error.code).toBe('agent_disabled')
  })

  it('owner and member invitations answer and list agent_id as null; list and revoke carry the agent_id of an agent invitation', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const agentId = await seedCrmAgent()
    const m = await create(worker(), tok, { email: 'm@x.test', role: 'member' })
    expect(m.json.agent_id).toBeNull()
    const a = await create(worker(), tok, makeBody(agentId))
    const listed = await call(worker(), 'GET', PATH, tok)
    expect(Object.fromEntries(listed.json.data.map((r: any) => [r.id, r.agent_id]))).toEqual({
      [m.json.id]: null,
      [a.json.id]: agentId,
    })
    const revoked = await call(worker(), 'POST', `${PATH}/${a.json.id}/revoke`, tok)
    expect(revoked.json).toMatchObject({ id: a.json.id, status: 'revoked', agent_id: agentId })
  })

  it('the operation description names agent_id and the new codes', async () => {
    const op = createVibaseRegistry().get('invitations.create')!
    for (const word of [
      'agent_id',
      'agent_id_required',
      'agent_disabled',
      'agent_has_account',
      'form_principal',
      'delegated_agent',
    ])
      expect(op.description).toContain(word)
  })
})

describe('reissue for an agent (AGT701 D15)', () => {
  it('a second invitation for the same agent revokes the first (with its audit row) and inserts the new one, also with another email', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const agentId = await seedCrmAgent()
    const first = await create(worker(), tok, { email: 'one@x.test', agent_id: agentId })
    const second = await create(worker(), tok, { email: 'two@x.test', agent_id: agentId })
    expect(second.status, JSON.stringify(second.json)).toBe(201)
    const [old] = await rows(w.control, 'select revoked_at from invitations where id = ?', first.json.id)
    expect(old!.revoked_at).not.toBeNull()
    expect(
      (await rows(w.control, 'select action from control_audit where target_id = ? order by id', first.json.id)).map(
        (r) => r.action,
      ),
    ).toEqual(['invitation.created', 'invitation.revoked'])
    const live = await rows(w.control, 'select id from invitations where agent_id = ? and revoked_at is null', agentId)
    expect(live).toEqual([{ id: second.json.id }])
  })

  it('the same email for the same agent is replaced, not refused', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const agentId = await seedCrmAgent()
    const first = await create(worker(), tok, { email: 'same@x.test', agent_id: agentId })
    const second = await create(worker(), tok, { email: 'same@x.test', agent_id: agentId })
    expect(second.status).toBe(201)
    expect(
      (await rows(w.control, 'select revoked_at from invitations where id = ?', first.json.id))[0]!.revoked_at,
    ).not.toBeNull()
  })

  for (const holder of ['member', 'another agent'] as const) {
    it(`a live invitation for the email held by ${holder}: 409 invitation_exists, the agent's own live invitation is not revoked, nothing written`, async () => {
      const owner = await human('owner')
      const tok = await owner.session()
      const agentId = await seedCrmAgent()
      const mine = await create(worker(), tok, { email: 'mine@x.test', agent_id: agentId })
      if (holder === 'member') await create(worker(), tok, { email: 'held@x.test', role: 'member' })
      else await create(worker(), tok, { email: 'held@x.test', agent_id: await seedCrmAgent() })
      const before = (await rows(w.control, 'select id from control_audit')).length
      const res = await create(worker(), tok, { email: 'held@x.test', agent_id: agentId })
      expect(res.status).toBe(409)
      expect(res.json.error.code).toBe('invitation_exists')
      expect(
        (await rows(w.control, 'select revoked_at from invitations where id = ?', mine.json.id))[0]!.revoked_at,
      ).toBeNull()
      expect(await rows(w.control, 'select id from control_audit')).toHaveLength(before)
    })
  }
})

describe('revoke and list (P6)', () => {
  it('revokes a live invitation: revoked_at set, one invitation.revoked audit row, the record back with status revoked', async () => {
    const owner = await human('owner')
    const id = await seed('live@x.test', 'pending')
    const res = await call(worker(), 'POST', `${PATH}/${id}/revoke`, await owner.session())
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({ id, email: 'live@x.test', status: 'revoked' })
    expect(res.json.revoked_at).not.toBeNull()
    expect((await rows(w.control, 'select revoked_at from invitations where id = ?', id))[0]!.revoked_at).toBe(
      res.json.revoked_at,
    )
    const audit = await rows(
      w.control,
      "select actor_id, action from control_audit where target_id = ? and action = 'invitation.revoked'",
      id,
    )
    expect(audit).toEqual([{ actor_id: owner.id, action: 'invitation.revoked' }])
  })

  it('an accepted, a revoked and an expired invitation answer 409 and add no audit row; an unknown id is 404, a malformed one 400', async () => {
    const owner = await human('owner')
    const wk = worker()
    const tok = await owner.session()
    const ids = [
      await seed('acc@x.test', 'accepted'),
      await seed('rev@x.test', 'revoked'),
      await seed('exp@x.test', 'expired'),
    ]
    const before = (await rows(w.control, 'select id from control_audit')).length
    for (const id of ids) {
      const res = await call(wk, 'POST', `${PATH}/${id}/revoke`, tok)
      expect(res.status, id).toBe(409)
      expect(res.json.error.code).toBe('invitation_not_pending')
    }
    expect(await rows(w.control, 'select id from control_audit')).toHaveLength(before)
    expect((await call(wk, 'POST', `${PATH}/${uuidv7(NOW)}/revoke`, tok)).status).toBe(404)
    expect((await call(wk, 'POST', `${PATH}/nope/revoke`, tok)).status).toBe(400)
  })

  it('list derives pending, accepted, revoked and expired (expired by the clock, no stored flag) and carries no token, hash or URL', async () => {
    const owner = await human('owner')
    for (const s of ['pending', 'accepted', 'revoked', 'expired'] as const) await seed(`${s}@x.test`, s)
    const res = await call(worker(), 'GET', PATH, await owner.session())
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.json.data.map((r: any) => [r.email, r.status]))).toEqual({
      'pending@x.test': 'pending',
      'accepted@x.test': 'accepted',
      'revoked@x.test': 'revoked',
      'expired@x.test': 'expired',
    })
    expect(res.json.next_cursor).toBeNull()
    for (const r of res.json.data)
      expect(Object.keys(r).sort()).toEqual([
        'accepted_at',
        'agent_id',
        'created_at',
        'created_by',
        'delivery',
        'email',
        'expires_at',
        'id',
        'revoked_at',
        'role',
        'status',
      ])
    expect(JSON.stringify(res.json)).not.toMatch(/token|hash|url|invite/i)
    // paging follows the other meta lists: limit and a cursor
    const first = await call(worker(), 'GET', `${PATH}?limit=3`, await owner.session())
    expect(first.json.data).toHaveLength(3)
    const rest = await call(worker(), 'GET', `${PATH}?limit=3&after=${first.json.next_cursor}`, await owner.session())
    expect(rest.json.data).toHaveLength(1)
    expect(rest.json.next_cursor).toBeNull()
  })

  it('an empty list is an empty page', async () => {
    const owner = await human('owner')
    expect((await call(worker(), 'GET', PATH, await owner.session())).json).toEqual({ data: [], next_cursor: null })
  })
})

describe('the authority matrix: operation x credential (P1, P2)', () => {
  type Who = 'owner session' | 'member session' | 'agent account' | 'delegated agent' | 'API-key agent'
  const who = [
    'owner session',
    'member session',
    'agent account',
    'delegated agent',
    'API-key agent',
  ] as const satisfies readonly Who[]
  const ops = ['create', 'list', 'revoke'] as const
  const cells = ops.flatMap((op) => who.map((w2) => [op, w2] as const))

  it.each(cells)('%s as %s', async (op, which) => {
    const owner = await human('owner')
    const target = await seed('target@x.test', 'pending')
    const token: Record<Who, () => Promise<string>> = {
      'owner session': () => owner.session(),
      'member session': async () => (await human('member', 'm@x.test')).session(),
      'agent account': async () => (await agentAccount()).session(),
      'delegated agent': async () => (await human('owner', 'delegator@x.test')).oauth(otherClient),
      'API-key agent': async () => bootKey,
    }
    const wk = worker()
    const before = JSON.stringify({
      i: await rows(w.control, 'select * from invitations order by id'),
      a: await rows(w.control, 'select * from control_audit order by id'),
    })
    const tok = await token[which]()
    const res =
      op === 'create'
        ? await create(wk, tok, { email: 'new@x.test', role: 'member' })
        : op === 'list'
          ? await call(wk, 'GET', PATH, tok)
          : await call(wk, 'POST', `${PATH}/${target}/revoke`, tok)
    if (which === 'owner session') {
      expect(res.status, JSON.stringify(res.json)).toBe(op === 'create' ? 201 : 200)
      return
    }
    expect(res.status, JSON.stringify(res.json)).toBe(403)
    expect(res.json.error.code).toBe('insufficient_scope')
    expect(
      JSON.stringify({
        i: await rows(w.control, 'select * from invitations order by id'),
        a: await rows(w.control, 'select * from control_audit order by id'),
      }),
    ).toBe(before)
  })

  it('P1: the two scopes are owner-held and human-only: not agent-grantable, not a member scope, declared, with consent text', () => {
    for (const s of ['invitations:read', 'invitations:write']) {
      expect(declared).toContain(s)
      expect(SCOPE_POLICY[s]).toEqual({ member: false, agentGrantable: false })
      expect(grantableScopes(declared)).not.toContain(s)
      expect(() => assertAgentGrantable([s], declared)).toThrow(/not grantable/)
      expect(scopesForRole('member', declared).toStrings()).not.toContain(s)
      expect(scopesForRole('owner', declared).toStrings()).toContain(s)
    }
  })

  it('MCP: the three tools are listed for the owner only, and tools/call create answers as REST does', async () => {
    const owner = await human('owner')
    const member = await human('member', 'm2@x.test')
    const wk = worker()
    const rpc = async (tok: string, method: string, params?: unknown) =>
      call(wk, 'POST', '/mcp', tok, { jsonrpc: '2.0', id: 1, method, params })
    const names = async (tok: string) =>
      ((await rpc(tok, 'tools/list')).json.result.tools as Array<{ name: string }>)
        .map((t) => t.name)
        .filter((n) => n.startsWith('invitations_'))
        .sort()
    expect(await names(await owner.session())).toEqual(['invitations_create', 'invitations_list', 'invitations_revoke'])
    expect(await names(await member.session())).toEqual([])
    const res = await rpc(await owner.session(), 'tools/call', {
      name: 'invitations_create',
      arguments: { email: 'mcp@x.test', role: 'member' },
    })
    const out = res.json.result
    expect(out.isError ?? false).toBe(false)
    expect((out.structuredContent ?? JSON.parse(out.content[0].text)).email).toBe('mcp@x.test')
    expect(await rows(w.control, "select email from invitations where email = 'mcp@x.test'")).toHaveLength(1)
  })
})

describe('a composition without a control store (P2)', () => {
  let clerk: ClerkKit
  let single: Awaited<ReturnType<typeof openWorkerD1>>
  beforeAll(async () => {
    clerk = await clerkKit()
    single = await openWorkerD1()
  })
  afterAll(() => single.dispose())

  it('on Clerk the three operations refuse with 501 provider_not_configured, and nothing is written', async () => {
    const issuer = clerk.issuer.issuer
    await single.d1.batch([
      single.d1
        .prepare('insert into deployment (singleton, organization_id, auth_provider, auth_org_id) values (1, ?, ?, ?)')
        .bind(orgId, 'clerk', issuer),
      single.d1
        .prepare(
          'insert into organizations (id, created_at, updated_at, name, auth_provider, auth_org_id) values (?, ?, ?, ?, ?, ?)',
        )
        .bind(orgId, NOW.toISOString(), NOW.toISOString(), 'Acme', 'clerk', issuer),
    ])
    const wk = composeD1Worker({ DB: single.d1, ...clerk.env, CLERK_WEBHOOK_SECRET: undefined }, { fetch: clerk.fetch })
    const tok = await mintClerkToken(clerk.issuer, { sub: 'user_a', extra: { vibase_role: 'owner' } })
    clerk.profiles.set('user_a', clerkUser({ id: 'user_a', email: 'a@x.test', verified: true }))
    const req = (method: string, path: string, body?: unknown) =>
      wk.fetch(
        new Request(`https://w.test${path}`, {
          method,
          headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }),
      )
    for (const res of [
      await req('POST', PATH, { email: 'a@x.test', role: 'member' }),
      await req('GET', PATH),
      await req('POST', `${PATH}/${uuidv7(NOW)}/revoke`),
    ]) {
      expect(res.status).toBe(501)
      expect(((await res.json()) as any).error.code).toBe('provider_not_configured')
    }
    expect(await rows(w.control, 'select id from invitations')).toEqual([])
  })
})

describe('one control batch, nothing in the CRM (D9 c)', () => {
  /** A control database whose audit insert cannot run. */
  const failingAudit = (real: D1Like): D1Like => ({
    prepare: (q: string) =>
      real.prepare(/insert into control_audit/i.test(q) ? 'insert into control_audit_missing values (1)' : q),
    batch: (s: D1PreparedLike[]) => real.batch(s),
  })

  it('an audit insert that fails leaves no invitation (create) and no revoked state (revoke): the answer is an error and the row is unchanged', async () => {
    const owner = await human('owner')
    const id = await seed('keep@x.test', 'pending')
    const wk = worker(failingAudit(w.control))
    const tok = await owner.session()
    expect((await create(wk, tok, { email: 'atomic@x.test', role: 'member' })).status).toBe(500)
    expect(await rows(w.control, "select id from invitations where email = 'atomic@x.test'")).toEqual([])
    expect((await call(wk, 'POST', `${PATH}/${id}/revoke`, tok)).status).toBe(500)
    expect((await rows(w.control, 'select revoked_at from invitations where id = ?', id))[0]!.revoked_at).toBeNull()
  })

  it('the three operations write no CRM event and no CRM row', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const wk = worker()
    const before = await crmCounts()
    const made = await create(wk, tok)
    expect(made.status).toBe(201)
    expect((await call(wk, 'GET', PATH, tok)).status).toBe(200)
    expect((await call(wk, 'POST', `${PATH}/${made.json.id}/revoke`, tok)).status).toBe(200)
    expect(await crmCounts()).toEqual(before)
    expect(await rows(w.d1, "select name from sqlite_master where name in ('invitations', 'control_audit')")).toEqual(
      [],
    )
  })

  it('every audit row the suite wrote holds no token and no hash', async () => {
    const owner = await human('owner')
    const tok = await owner.session()
    const wk = worker()
    const made = await create(wk, tok)
    await call(wk, 'POST', `${PATH}/${made.json.id}/revoke`, tok)
    const hashes = (await rows(w.control, 'select token_hash from invitations')).map((r) => r.token_hash as string)
    for (const a of await rows(w.control, 'select detail from control_audit')) {
      expect(
        Object.keys(JSON.parse(a.detail))
          .filter((k) => k !== 'delivery')
          .sort(),
      ).toEqual(['email', 'expires_at', 'role'])
      for (const h of hashes) expect(a.detail).not.toContain(h)
    }
  })

  it('schema discovery does not show the control tables', async () => {
    const owner = await human('owner')
    const res = await call(worker(), 'GET', '/meta/v1/schema', await owner.session())
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toMatch(/invitations|control_audit/)
  })
})
