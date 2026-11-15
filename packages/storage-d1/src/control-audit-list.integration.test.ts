import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { listControlAudit, openControlDb } from './control-store.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE261]] P3, P4, P6: the control store's audit read, on a real control-plane D1 (Miniflare). `control_audit` refuses DELETE, so every test seeds its own distinct targets.
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
let local: LocalD1
let control: D1Like
beforeAll(async () => {
  local = await openLocalD1(['C'], { control: ['C'] })
  control = local.bindings.C!
})
afterAll(() => local.dispose())

let n = 0
const hex = (k: number) => k.toString(16).padStart(12, '0')
const nextId = () => `0190b2c4-0000-7000-8000-${hex(++n)}`
const put = async (a: { action: string; targetType: string; targetId: string; detail?: unknown }) => {
  const id = nextId()
  await control
    .prepare(
      'insert into control_audit (id, at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, '2026-11-14T10:00:00.000Z', ACTOR, a.action, a.targetType, a.targetId, JSON.stringify(a.detail ?? {}))
    .run()
  return id
}
const db = () => openControlDb(control)

describe('listControlAudit', () => {
  it('returns rows in id order, camel-cased, detail parsed to the stored object, and writes nothing', async () => {
    const t = `t-order-${n}`
    const a = await put({
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: t,
      detail: { email: 'a@x.test', role: 'member' },
    })
    const b = await put({
      action: 'invitation.revoked',
      targetType: 'invitation',
      targetId: t,
      detail: { reason: 'email_failed' },
    })
    const before = (await control.prepare('select count(*) n from control_audit').first()) as { n: number }
    const rows = await listControlAudit(db(), { targetId: t, limit: 10 })
    expect(rows.map((r) => r.id)).toEqual([a, b])
    expect(rows[0]).toEqual({
      id: a,
      at: '2026-11-14T10:00:00.000Z',
      actorId: ACTOR,
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: t,
      detail: { email: 'a@x.test', role: 'member' },
    })
    const after = (await control.prepare('select count(*) n from control_audit').first()) as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('each filter alone and combined is an exact match', async () => {
    const tag = `t-filter-${n}`
    await put({ action: 'invitation.created', targetType: 'invitation', targetId: `${tag}-1` })
    await put({ action: 'invitation.revoked', targetType: 'invitation', targetId: `${tag}-1` })
    await put({ action: 'user.sessions_revoked', targetType: 'user', targetId: `${tag}-2` })
    const all = (await listControlAudit(db(), { limit: 200 })).filter((r) => r.targetId.startsWith(tag))
    expect(all).toHaveLength(3)
    const f = async (q: Parameters<typeof listControlAudit>[1]) =>
      (await listControlAudit(db(), q)).filter((r) => r.targetId.startsWith(tag)).map((r) => r.action)
    expect(await f({ limit: 200, action: 'invitation.created' })).toEqual(['invitation.created'])
    expect(await f({ limit: 200, targetType: 'user' })).toEqual(['user.sessions_revoked'])
    expect(await f({ limit: 200, targetId: `${tag}-1` })).toEqual(['invitation.created', 'invitation.revoked'])
    expect(await f({ limit: 200, targetId: `${tag}-1`, action: 'invitation.revoked' })).toEqual(['invitation.revoked'])
    expect(await f({ limit: 200, targetType: 'user', action: 'invitation.created' })).toEqual([])
    expect(await f({ limit: 200, targetId: tag })).toEqual([])
  })

  it('pages by id: limit, then after the last id, in ascending order', async () => {
    const t = `t-page-${n}`
    const ids = [] as string[]
    for (let i = 0; i < 5; i++) ids.push(await put({ action: 'x.y', targetType: 'page', targetId: t }))
    const p1 = await listControlAudit(db(), { targetId: t, limit: 2 })
    const p2 = await listControlAudit(db(), { targetId: t, limit: 2, after: p1[1]!.id })
    const p3 = await listControlAudit(db(), { targetId: t, limit: 2, after: p2[1]!.id })
    expect([...p1, ...p2, ...p3].map((r) => r.id)).toEqual(ids)
    expect(p3).toHaveLength(1)
  })
})
