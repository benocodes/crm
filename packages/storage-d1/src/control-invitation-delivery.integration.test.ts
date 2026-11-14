import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { createInvitation, listInvitations, openControlDb, revokeInvitation, type NewInvitation } from './control-store.js'
import { CONTROL_MIGRATIONS_DIR, openLocalD1, splitStatements, type LocalD1 } from './test/index.js'

// [[CORE248]] D3: control 0003 adds `invitations.delivery` (not null default 'link', check link|email); the store writes and reads it; the audit rows carry it.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
const NOW = '2026-11-14T10:00:00.000Z'
const DAY = 86_400_000
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString()
let local: LocalD1
beforeAll(async () => {
  local = await openLocalD1(['EMPTY', 'OLD', 'NEW'], { migrate: false, control: [] })
})
afterAll(() => local.dispose())

let n = 0
const hex = (k: number) => k.toString(16).padStart(12, '0')
const nextId = () => `0190b2c4-0000-7000-8000-${hex(++n)}`
const hash = () => `${String(++n).padStart(8, '0')}${'a'.repeat(56)}`
const rows = async (d1: D1Like, text: string, ...binds: unknown[]) => ((await d1.prepare(text).bind(...binds).all()).results ?? []) as Array<Record<string, any>>
const run = (d1: D1Like, text: string, ...binds: unknown[]) => d1.prepare(text).bind(...binds).run().then(() => null, (e: Error) => e.message)
const files = readdirSync(CONTROL_MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
const apply = async (d1: D1Like, only: (f: string) => boolean) => {
  for (const f of files.filter(only)) await d1.batch(splitStatements(readFileSync(join(CONTROL_MIGRATIONS_DIR, f), 'utf-8')).map((s) => d1.prepare(s)))
}
const insert = (d1: D1Like, email: string, extra = '') =>
  run(d1, `insert into invitations (id, organization_id, email, role, token_hash, expires_at, created_by, created_at, accepted_at, revoked_at${extra ? ', delivery' : ''}) values (?, ?, ?, 'member', ?, ?, ?, ?, null, ${email.startsWith('revoked') ? "'" + plus(NOW, 1000) + "'" : 'null'}${extra ? ', ?' : ''})`, ...[nextId(), ORG, email, hash(), plus(NOW, 7 * DAY), ACTOR, NOW, ...(extra ? [extra] : [])])

describe('control migration 0003', () => {
  it('is the third control migration and is listed in the manifest', () => {
    expect(files[2]).toMatch(/^0003_/)
    expect(CONTROL_MIGRATIONS.map((m) => m.name)).toEqual(files)
  })

  it('migrates a 0002 database holding a pending and a revoked invitation: both rows become delivery link', async () => {
    const d1 = local.bindings.OLD!
    await apply(d1, (f) => !f.startsWith('0003_'))
    expect(await insert(d1, 'pending@x.test')).toBeNull()
    expect(await insert(d1, 'revoked@x.test')).toBeNull()
    await apply(d1, (f) => f.startsWith('0003_'))
    const got = await rows(d1, 'select email, delivery from invitations order by email')
    expect(got).toEqual([{ email: 'pending@x.test', delivery: 'link' }, { email: 'revoked@x.test', delivery: 'link' }])
  })

  it('migrates a database with no invitations cleanly, and the check refuses another value', async () => {
    const d1 = local.bindings.EMPTY!
    await apply(d1, () => true)
    expect(await rows(d1, 'select count(*) n from invitations')).toEqual([{ n: 0 }])
    expect(await insert(d1, 'e@x.test', 'email')).toBeNull()
    expect(await insert(d1, 'l@x.test', 'link')).toBeNull()
    expect(await insert(d1, 'x@x.test', 'sms')).toMatch(/CHECK/i)
    expect(await insert(d1, 'd@x.test')).toBeNull()
    expect((await rows(d1, "select delivery from invitations where email = 'd@x.test'"))[0]!.delivery).toBe('link')
  })
})

describe('the control store and delivery', () => {
  const inv = (over: Partial<NewInvitation> = {}): NewInvitation => ({ id: nextId(), auditId: nextId(), organizationId: ORG, email: `s${n}@x.test`, role: 'member', tokenHash: hash(), expiresAt: plus(NOW, 7 * DAY), createdBy: ACTOR, now: NOW, ...over })
  const audit = (id: string) => rows(local.bindings.NEW!, 'select * from control_audit where target_id = ? order by id', id)
  beforeAll(async () => {
    await apply(local.bindings.NEW!, () => true)
  })

  it('writes delivery on create, returns it from list, and the audit detail carries it', async () => {
    const c = openControlDb(local.bindings.NEW!)
    const a = inv({ delivery: 'email' })
    const b = inv()
    expect(await createInvitation(c, a)).toBe('created')
    expect(await createInvitation(c, b)).toBe('created')
    const listed = await listInvitations(c, { limit: 200 })
    expect(listed.find((r) => r.id === a.id)!.delivery).toBe('email')
    expect(listed.find((r) => r.id === b.id)!.delivery).toBe('link')
    expect(JSON.parse((await audit(a.id))[0]!.detail)).toMatchObject({ delivery: 'email' })
    expect(JSON.parse((await audit(b.id))[0]!.detail)).toMatchObject({ delivery: 'link' })
  })

  it('a revoke with a reason records it in the audit detail; without one the detail has no reason', async () => {
    const c = openControlDb(local.bindings.NEW!)
    const a = inv({ delivery: 'email' })
    const b = inv()
    await createInvitation(c, a)
    await createInvitation(c, b)
    await revokeInvitation(c, { id: a.id, auditId: nextId(), actorId: ACTOR, now: plus(NOW, 1000), reason: 'email_failed' })
    await revokeInvitation(c, { id: b.id, auditId: nextId(), actorId: ACTOR, now: plus(NOW, 1000) })
    expect(JSON.parse((await audit(a.id))[1]!.detail)).toMatchObject({ reason: 'email_failed' })
    expect(JSON.parse((await audit(b.id))[1]!.detail)).not.toHaveProperty('reason')
  })
})
