import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import {
  createInvitation,
  findAdoptableInvitation,
  findLiveInvitationByToken,
  listInvitations,
  openControlDb,
  reissueAgentInvitation,
  reissueOwnerInvitation,
  revokeInvitation,
  type NewInvitation,
} from './control-store.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// [[AGT701]] (cycle 1): the control genesis holds the binding of an agent invitation to its agent (D14, ruling 701.27: `invitations.agent_id` is in `0001_genesis.sql`, not a 0002 migration) and the control store
// reads and writes it (D15, D17, D19). A fresh control database per test: `control_audit` refuses DELETE.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
const NOW = '2026-11-28T10:00:00.000Z'
const AT = '2026-11-28T10:01:00.000Z'
const DAY = 86_400_000
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString()

let local: LocalD1
let ctl: D1Like
beforeEach(async () => {
  local = await openLocalD1(['C'], { control: ['C'] })
  ctl = local.bindings.C!
})
afterEach(() => local.dispose())

let n = 0
const hex = (k: number) => k.toString(16).padStart(12, '0')
const nextId = () => `0190b2c4-0000-7000-8000-${hex(++n)}`
const hash = () => `${String(++n).padStart(8, '0')}${'a'.repeat(56)}`
const AGENT = '0190b2c4-0000-7000-8000-00000000c001'
const OTHER_AGENT = '0190b2c4-0000-7000-8000-00000000c002'
const inv = (over: Partial<NewInvitation> = {}): NewInvitation => ({
  id: nextId(),
  auditId: nextId(),
  organizationId: ORG,
  email: `p${n}@x.test`,
  role: 'member',
  tokenHash: hash(),
  expiresAt: plus(NOW, 7 * DAY),
  createdBy: ACTOR,
  now: NOW,
  ...over,
})
const agentInv = (agentId: string, over: Partial<NewInvitation> = {}) =>
  inv({ role: 'agent', agentId, ...over }) as NewInvitation
const c = () => openControlDb(ctl)
const rows = async (text: string, ...binds: unknown[]) =>
  ((
    await ctl
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const audit = (targetId: string) => rows('select * from control_audit where target_id = ? order by id', targetId)
const insertRaw = (role: string, agentId: string | null, email = `raw${++n}@x.test`) =>
  ctl
    .prepare(
      'insert into invitations (id, organization_id, email, role, token_hash, expires_at, created_by, created_at, agent_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(nextId(), ORG, email, role, hash(), plus(NOW, DAY), ACTOR, NOW, agentId)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )

describe('control genesis holds the binding (AGT701 D14, ruling 701.27)', () => {
  it('the invitations table has a nullable agent_id column and the partial index idx_invitations_agent_id', async () => {
    const col = (await rows('select name, "notnull" as nn from pragma_table_info(\'invitations\')')).find(
      (r) => r.name === 'agent_id',
    )
    expect(col).toMatchObject({ nn: 0 })
    const idx = await rows("select sql from sqlite_master where type = 'index' and name = 'idx_invitations_agent_id'")
    expect(idx).toHaveLength(1)
    expect(idx[0]!.sql).toMatch(/WHERE agent_id IS NOT NULL/i)
  })

  it('invitations_agent_id_uuid refuses a malformed agent id', async () => {
    expect(await insertRaw('agent', 'not-a-uuid')).toMatch(/invitations_agent_id_uuid/)
    expect(await insertRaw('agent', AGENT)).toBeNull()
  })

  it('invitations_agent_id_iff_agent refuses role agent with a null agent_id', async () => {
    expect(await insertRaw('agent', null)).toMatch(/invitations_agent_id_iff_agent/)
  })

  it('invitations_agent_id_iff_agent refuses a member or owner invitation that carries an agent_id', async () => {
    expect(await insertRaw('member', AGENT)).toMatch(/invitations_agent_id_iff_agent/)
    expect(await insertRaw('owner', AGENT)).toMatch(/invitations_agent_id_iff_agent/)
    expect(await insertRaw('member', null)).toBeNull()
  })
})

describe('the control store carries agent_id (AGT701 D17, D19)', () => {
  it('createInvitation stores it; list, findLiveByToken and findAdoptable return it; owner and member records carry null', async () => {
    const a = agentInv(AGENT, { email: 'agent@x.test' })
    expect(await createInvitation(c(), a)).toBe('created')
    const m = inv({ email: 'member@x.test' })
    await createInvitation(c(), m)
    const listed = await listInvitations(c(), { limit: 50 })
    expect(listed.find((r) => r.id === a.id)).toMatchObject({ role: 'agent', agentId: AGENT })
    expect(listed.find((r) => r.id === m.id)).toMatchObject({ role: 'member', agentId: null })
    const byToken = await findLiveInvitationByToken(c(), { tokenHash: a.tokenHash, email: 'agent@x.test', now: AT })
    expect(byToken).toMatchObject({ id: a.id, agentId: AGENT })
    const adoptable = await findAdoptableInvitation(c(), { email: 'agent@x.test', accountCreatedAt: AT, now: AT })
    expect(adoptable).toMatchObject({ id: a.id, agentId: AGENT })
    const memberByToken = await findLiveInvitationByToken(c(), { tokenHash: m.tokenHash, email: m.email, now: AT })
    expect(memberByToken).toMatchObject({ agentId: null })
  })

  it('the revoke record carries agent_id', async () => {
    const a = agentInv(AGENT, { email: 'rev@x.test' })
    await createInvitation(c(), a)
    const out = await revokeInvitation(c(), { id: a.id, auditId: nextId(), actorId: ACTOR, now: AT })
    expect(out).toMatchObject({ result: 'revoked', record: { agentId: AGENT } })
  })

  it("the invitation.created audit detail carries agent_id for an agent invitation; owner and member rows keep today's detail", async () => {
    const a = agentInv(AGENT, { email: 'aud@x.test' })
    await createInvitation(c(), a)
    expect(JSON.parse((await audit(a.id))[0]!.detail)).toEqual({
      email: 'aud@x.test',
      role: 'agent',
      expires_at: a.expiresAt,
      delivery: 'link',
      agent_id: AGENT,
    })
    const m = inv({ email: 'aud-m@x.test' })
    await createInvitation(c(), m)
    expect(Object.keys(JSON.parse((await audit(m.id))[0]!.detail)).sort()).toEqual([
      'delivery',
      'email',
      'expires_at',
      'role',
    ])
  })
})

describe('reissueAgentInvitation (AGT701 D15): one batch, nothing read first', () => {
  it("revokes the agent's live invitations (each audited) and inserts the new one, also when the email differs", async () => {
    const first = agentInv(AGENT, { email: 'one@x.test' })
    const second = agentInv(AGENT, { email: 'two@x.test' })
    await createInvitation(c(), first)
    await createInvitation(c(), second) // never produced by the operation; seeds two live ones
    const fresh = agentInv(AGENT, { email: 'three@x.test', now: AT })
    const out = await reissueAgentInvitation(c(), { ...fresh, newAuditId: nextId })
    expect(out).toEqual({ result: 'created', revoked: 2 })
    for (const old of [first, second]) {
      expect((await rows('select revoked_at from invitations where id = ?', old.id))[0]!.revoked_at).toBe(AT)
      const revoked = (await audit(old.id)).find((r) => r.action === 'invitation.revoked')!
      expect(revoked).toMatchObject({ at: AT, actor_id: ACTOR, target_type: 'invitation' })
      expect(JSON.parse(revoked.detail)).toMatchObject({ role: 'agent' })
    }
    expect((await audit(fresh.id)).map((r) => r.action)).toEqual(['invitation.created'])
    expect((await rows('select revoked_at from invitations where id = ?', fresh.id))[0]!.revoked_at).toBeNull()
  })

  it('the same email for the same agent is replaced: the old one revoked, the new one live', async () => {
    const first = agentInv(AGENT, { email: 'same@x.test' })
    await createInvitation(c(), first)
    const fresh = agentInv(AGENT, { email: 'same@x.test', now: AT })
    expect(await reissueAgentInvitation(c(), { ...fresh, newAuditId: nextId })).toEqual({
      result: 'created',
      revoked: 1,
    })
    expect((await rows('select revoked_at from invitations where id = ?', first.id))[0]!.revoked_at).toBe(AT)
  })

  it("another agent's live invitations are left alone", async () => {
    const other = agentInv(OTHER_AGENT, { email: 'other@x.test' })
    await createInvitation(c(), other)
    const out = await reissueAgentInvitation(c(), {
      ...agentInv(AGENT, { email: 'mine@x.test', now: AT }),
      newAuditId: nextId,
    })
    expect(out).toEqual({ result: 'created', revoked: 0 })
    expect((await rows('select revoked_at from invitations where id = ?', other.id))[0]!.revoked_at).toBeNull()
  })

  for (const [label, blocker] of [
    ['another agent', () => agentInv(OTHER_AGENT, { email: 'blocked@x.test' })],
    ['a member invitation', () => inv({ email: 'blocked@x.test', role: 'member' })],
    ['an owner invitation', () => inv({ email: 'blocked@x.test', role: 'owner' })],
  ] as const) {
    it(`a live invitation for the email held by ${label}: live_exists, the agent's own live invitation is not revoked, nothing is inserted or audited`, async () => {
      const mine = agentInv(AGENT, { email: 'mine@x.test' })
      await createInvitation(c(), mine)
      const held = blocker()
      await createInvitation(c(), held)
      const auditBefore = (await rows('select count(*) n from control_audit'))[0]!.n
      const invBefore = (await rows('select count(*) n from invitations'))[0]!.n
      const fresh = agentInv(AGENT, { email: 'blocked@x.test', now: AT })
      expect(await reissueAgentInvitation(c(), { ...fresh, newAuditId: nextId })).toEqual({ result: 'live_exists' })
      expect((await rows('select revoked_at from invitations where id = ?', mine.id))[0]!.revoked_at).toBeNull()
      expect((await rows('select revoked_at from invitations where id = ?', held.id))[0]!.revoked_at).toBeNull()
      expect((await rows('select count(*) n from invitations'))[0]!.n).toBe(invBefore)
      expect((await rows('select count(*) n from control_audit'))[0]!.n).toBe(auditBefore)
    })
  }

  it("owner reissue is unchanged: it does not touch an agent's live invitation", async () => {
    const mine = agentInv(AGENT, { email: 'mine@x.test' })
    await createInvitation(c(), mine)
    const out = await reissueOwnerInvitation(c(), {
      ...inv({ email: 'owner@x.test', role: 'owner', now: AT }),
      newAuditId: nextId,
    })
    expect(out).toEqual({ result: 'created', revoked: 0 })
    expect((await rows('select revoked_at from invitations where id = ?', mine.id))[0]!.revoked_at).toBeNull()
  })
})
