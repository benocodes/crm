import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like, D1PreparedLike } from './binding.js'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { createInvitation, listInvitations, openControlDb, reissueOwnerInvitation, revokeInvitation, type NewInvitation } from './control-store.js'
import { applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE245]] P3-P6: control 0002 (`invitations`, append-only `control_audit`) and the control store's invitation reads and writes, on a real control-plane D1 (Miniflare).
// `control_audit` refuses DELETE, so tables are never emptied between tests: every test uses its own e-mail addresses and ids.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
const NOW = '2026-11-14T10:00:00.000Z'
const DAY = 86_400_000
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString()
let local: LocalD1
let control: D1Like
let crm: D1Like
beforeAll(async () => {
  local = await openLocalD1(['C', 'CRM'], { control: ['C'] })
  control = local.bindings.C!
  crm = local.bindings.CRM!
})
afterAll(() => local.dispose())

let n = 0
const hex = (k: number) => k.toString(16).padStart(12, '0')
const nextId = () => `0190b2c4-0000-7000-8000-${hex(++n)}`
const hash = () => `${String(++n).padStart(8, '0')}${'a'.repeat(56)}`
const inv = (over: Partial<NewInvitation> = {}): NewInvitation => ({ id: nextId(), auditId: nextId(), organizationId: ORG, email: `p${n}@x.test`, role: 'member', tokenHash: hash(), expiresAt: plus(NOW, 7 * DAY), createdBy: ACTOR, now: NOW, ...over })
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) => ((await d1.prepare(text).bind(...binds).all()).results ?? []) as Array<Record<string, any>>
const run = (d1: D1Like, text: string, ...binds: unknown[]) => d1.prepare(text).bind(...binds).run().then(() => null, (e: Error) => e.message)
const c = () => openControlDb(control)
const audit = (targetId: string) => rows(control, 'select * from control_audit where target_id = ? order by id', targetId)
/** An accepted invitation, seeded directly: no acceptance path exists in this cycle. */
const seedAccepted = (email: string) =>
  run(control, "insert into invitations (id, organization_id, email, role, token_hash, expires_at, created_by, created_at, accepted_at, revoked_at) values (?, ?, ?, 'member', ?, ?, ?, ?, ?, null)", nextId(), ORG, email, hash(), plus(NOW, 7 * DAY), ACTOR, NOW, plus(NOW, 1000))

describe('control migration 0002: invitations and control_audit exist only in the control plane', () => {
  it('the control manifest lists 0002, applied under the control tracker alongside 0001', async () => {
    expect(CONTROL_MIGRATIONS.map((m) => m.name)).toEqual(['0001_control_plane.sql', '0002_invitations.sql'])
    expect((await rows(control, 'select name from d1_migrations order by id')).map((r) => r.name)).toEqual(['0001_control_plane.sql', '0002_invitations.sql'])
  })

  it('the two tables are in the control database with the charter columns, and in no CRM database', async () => {
    const cols = async (t: string) => (await rows(control, `select name from pragma_table_info('${t}')`)).map((r) => r.name)
    expect(await cols('invitations')).toEqual(['id', 'organization_id', 'email', 'role', 'token_hash', 'expires_at', 'created_by', 'created_at', 'accepted_at', 'revoked_at'])
    expect(await cols('control_audit')).toEqual(['id', 'at', 'actor_id', 'action', 'target_type', 'target_id', 'detail'])
    await applyMigrations(crm)
    const crmTables = (await rows(crm, "select name from sqlite_master where type = 'table'")).map((r) => r.name)
    expect(crmTables).not.toContain('invitations')
    expect(crmTables).not.toContain('control_audit')
  })

  it('control_audit is append-only: UPDATE and DELETE are refused', async () => {
    const a = inv()
    expect(await createInvitation(c(), a)).toBe('created')
    expect(await run(control, "update control_audit set action = 'x' where target_id = ?", a.id)).toMatch(/append_only/)
    expect(await run(control, 'delete from control_audit where target_id = ?', a.id)).toMatch(/append_only/)
    expect(await audit(a.id)).toHaveLength(1)
  })

  it('token_hash is unique', async () => {
    const a = inv()
    expect(await createInvitation(c(), a)).toBe('created')
    await expect(createInvitation(c(), inv({ tokenHash: a.tokenHash }))).rejects.toThrow(/UNIQUE/i)
  })
})

describe('create (P3, P4, P5)', () => {
  it('writes the invitation and its audit row: actor, action, target, detail without the token or its hash', async () => {
    const a = inv({ email: 'new@x.test', role: 'owner' })
    expect(await createInvitation(c(), a)).toBe('created')
    expect(await rows(control, 'select * from invitations where id = ?', a.id)).toEqual([
      { id: a.id, organization_id: ORG, email: 'new@x.test', role: 'owner', token_hash: a.tokenHash, expires_at: a.expiresAt, created_by: ACTOR, created_at: NOW, accepted_at: null, revoked_at: null },
    ])
    const [row, ...rest] = await audit(a.id)
    expect(rest).toEqual([])
    expect(row).toEqual({ id: a.auditId, at: NOW, actor_id: ACTOR, action: 'invitation.created', target_type: 'invitation', target_id: a.id, detail: expect.any(String) })
    expect(JSON.parse(row!.detail)).toEqual({ email: 'new@x.test', role: 'owner', expires_at: a.expiresAt })
  })

  it('a second live invitation for the same address is refused and writes nothing; after a revoke, or once the first has expired, a new one is created', async () => {
    const first = inv({ email: 'dup@x.test' })
    expect(await createInvitation(c(), first)).toBe('created')
    const second = inv({ email: 'dup@x.test' })
    expect(await createInvitation(c(), second)).toBe('live_exists')
    expect(await rows(control, 'select id from invitations where id = ?', second.id)).toEqual([])
    expect(await audit(second.id)).toEqual([])
    expect(await revokeInvitation(c(), { id: first.id, auditId: nextId(), actorId: ACTOR, now: plus(NOW, 1000) })).toMatchObject({ result: 'revoked' })
    expect(await createInvitation(c(), second)).toBe('created')
    // expiry by the clock: the live one lapses, so a later create passes
    const third = inv({ email: 'dup@x.test', now: plus(NOW, 8 * DAY), expiresAt: plus(NOW, 15 * DAY) })
    expect(await createInvitation(c(), third)).toBe('created')
  })

  it('empty state: the first invitation in an empty table is created', async () => {
    const fresh = await openLocalD1(['F'], { control: ['F'] })
    try {
      expect(await createInvitation(openControlDb(fresh.bindings.F!), inv())).toBe('created')
    } finally {
      await fresh.dispose()
    }
  })
})

describe('revoke (P6) and list', () => {
  it('a live invitation is revoked with its audit row; an unknown id is not_found', async () => {
    const a = inv()
    await createInvitation(c(), a)
    const out = await revokeInvitation(c(), { id: a.id, auditId: nextId(), actorId: ACTOR, now: plus(NOW, 5000) })
    expect(out).toMatchObject({ result: 'revoked', record: { id: a.id, revokedAt: plus(NOW, 5000), acceptedAt: null } })
    const rowsAfter = await audit(a.id)
    expect(rowsAfter.map((r) => r.action)).toEqual(['invitation.created', 'invitation.revoked'])
    expect(JSON.parse(rowsAfter[1]!.detail)).toEqual({ email: a.email, role: a.role, expires_at: a.expiresAt })
    expect(rowsAfter[1]!.actor_id).toBe(ACTOR)
    expect(await revokeInvitation(c(), { id: nextId(), auditId: nextId(), actorId: ACTOR, now: NOW })).toEqual({ result: 'not_found' })
  })

  it('a revoked, an accepted and an expired invitation are not_live and write no audit row', async () => {
    const revoked = inv()
    await createInvitation(c(), revoked)
    await revokeInvitation(c(), { id: revoked.id, auditId: nextId(), actorId: ACTOR, now: plus(NOW, 1000) })
    const expired = inv({ expiresAt: plus(NOW, 1000) })
    await createInvitation(c(), expired)
    const acceptedEmail = 'accepted@x.test'
    expect(await seedAccepted(acceptedEmail)).toBeNull()
    const accepted = (await rows(control, 'select id from invitations where email = ?', acceptedEmail))[0]!.id as string
    const before = (await rows(control, 'select count(*) as n from control_audit'))[0]!.n
    for (const [id, now] of [[revoked.id, plus(NOW, 9000)], [expired.id, plus(NOW, 2000)], [accepted, plus(NOW, 9000)]] as const) {
      expect(await revokeInvitation(c(), { id, auditId: nextId(), actorId: ACTOR, now })).toMatchObject({ result: 'not_live' })
    }
    expect((await rows(control, 'select count(*) as n from control_audit'))[0]!.n).toBe(before)
    expect((await rows(control, 'select revoked_at from invitations where id = ?', accepted))[0]!.revoked_at).toBeNull()
  })

  it('list pages by id and never returns a token or its hash', async () => {
    const made = [inv(), inv(), inv()]
    for (const m of made) await createInvitation(c(), m)
    const page = await listInvitations(c(), { after: made[0]!.id, limit: 2 })
    expect(page.map((r) => r.id)).toEqual([made[1]!.id, made[2]!.id].slice(0, 2))
    for (const r of page) {
      expect(Object.keys(r).sort()).toEqual(['acceptedAt', 'createdAt', 'createdBy', 'email', 'expiresAt', 'id', 'organizationId', 'revokedAt', 'role'])
      expect(JSON.stringify(r)).not.toContain('aaaaaaaa')
    }
  })
})

describe('one control batch (D9 c)', () => {
  /** A control database whose audit insert fails: every statement writing control_audit is replaced by one that cannot run. */
  const failingAudit = (real: D1Like): D1Like => ({
    prepare: (q: string) => real.prepare(/insert into control_audit/i.test(q) ? 'insert into control_audit_missing values (1)' : q),
    batch: (s: D1PreparedLike[]) => real.batch(s),
  })

  it('a failing audit insert leaves no invitation row (create) and no revoked state (revoke)', async () => {
    const a = inv({ email: 'atomic@x.test' })
    await expect(createInvitation(openControlDb(failingAudit(control)), a)).rejects.toThrow()
    expect(await rows(control, 'select id from invitations where email = ?', 'atomic@x.test')).toEqual([])
    const b = inv()
    expect(await createInvitation(c(), b)).toBe('created')
    await expect(revokeInvitation(openControlDb(failingAudit(control)), { id: b.id, auditId: nextId(), actorId: ACTOR, now: plus(NOW, 1000) })).rejects.toThrow()
    expect((await rows(control, 'select revoked_at from invitations where id = ?', b.id))[0]!.revoked_at).toBeNull()
    expect((await audit(b.id)).map((r) => r.action)).toEqual(['invitation.created'])
  })
})

describe('reissue the owner invitation (P7)', () => {
  it('revokes every live owner invitation and creates a fresh one in one batch, each change audited', async () => {
    const old = inv({ email: 'owner-old@x.test', role: 'owner' })
    await createInvitation(c(), old)
    const fresh = inv({ email: 'owner-new@x.test', role: 'owner', now: plus(NOW, 60_000) })
    const out = await reissueOwnerInvitation(c(), { ...fresh, newAuditId: nextId })
    expect(out).toEqual({ result: 'created', revoked: [old.id] })
    expect((await rows(control, 'select revoked_at from invitations where id = ?', old.id))[0]!.revoked_at).toBe(plus(NOW, 60_000))
    expect((await audit(old.id)).map((r) => r.action)).toEqual(['invitation.created', 'invitation.revoked'])
    expect((await audit(fresh.id)).map((r) => r.action)).toEqual(['invitation.created'])
  })

  it('a live non-owner invitation for the same address refuses the reissue before anything is revoked', async () => {
    const live = inv({ email: 'both@x.test', role: 'member' })
    await createInvitation(c(), live)
    const owner = inv({ email: 'other-owner@x.test', role: 'owner' })
    await createInvitation(c(), owner)
    const out = await reissueOwnerInvitation(c(), { ...inv({ email: 'both@x.test', role: 'owner', now: plus(NOW, 60_000) }), newAuditId: nextId })
    expect(out).toEqual({ result: 'live_exists' })
    expect((await rows(control, 'select revoked_at from invitations where id = ?', owner.id))[0]!.revoked_at).toBeNull()
  })
})

describe('the audit never holds a token or a hash', () => {
  it('no audit row written by this file mentions any stored token hash', async () => {
    const hashes = (await rows(control, 'select token_hash from invitations')).map((r) => r.token_hash as string)
    expect(hashes.length).toBeGreaterThan(5)
    const details = (await rows(control, 'select detail from control_audit')).map((r) => r.detail as string)
    for (const h of hashes) for (const d of details) expect(d).not.toContain(h)
    for (const d of details) expect(Object.keys(JSON.parse(d)).sort()).toEqual(['email', 'expires_at', 'role'])
  })
})
