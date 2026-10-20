import { describe, expect, it } from 'vitest'
import { withContext } from '../context.js'
import { ScopeSet } from '../scopes.js'
import { useAdminKit } from '../test/admin-kit.js'
import { membershipRecord } from '../account/organizations.js'
import { updateResource } from './crud.js'
import { memberships } from './memberships.js'
import { ApiError } from '../errors.js'

const k = useAdminKit()
const mid = async (userId: string) =>
  (await k.owner.selectFrom('memberships').select('id').where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id

describe('memberships', () => {
  it('lists', async () => {
    const t = await k.seedOrg()
    const res = await k.call('/memberships', 'o', { org: t.organizationId })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    for (const m of body.data) {
      membershipRecord.parse(m)
      expect('deleted_at' in m).toBe(false)
    }
  })

  it('filters', async () => {
    const t = await k.seedOrg()
    const byUser = await (await k.call(`/memberships?user_id=${t.memberId}`, 'o', { org: t.organizationId })).json()
    expect(byUser.data.map((m: { user_id: string }) => m.user_id)).toEqual([t.memberId])
    const byRole = await (await k.call('/memberships?role=owner', 'o', { org: t.organizationId })).json()
    expect(byRole.data.map((m: { user_id: string }) => m.user_id)).toEqual([t.ownerId])
  })

  it('a member reads', async () => {
    const t = await k.seedOrg()
    expect((await k.call('/memberships', 'm', { org: t.organizationId })).status).toBe(200)
  })

  it('promotes', async () => {
    const t = await k.seedOrg()
    const id = await mid(t.memberId)
    const res = await k.call(`/memberships/${id}`, 'o', { method: 'PATCH', org: t.organizationId, body: { role: 'owner' } })
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('owner')
    const events = (await k.events()).filter((e) => e.type === 'membership.updated')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor_id: t.ownerId })
    expect(events[0]!.before.role).toBe('member')
  })

  it('a member cannot write', async () => {
    const t = await k.seedOrg()
    const oid = await mid(t.ownerId)
    for (const method of ['PATCH', 'DELETE']) {
      const res = await k.call(`/memberships/${oid}`, 'm', { method, org: t.organizationId, body: method === 'PATCH' ? { role: 'member' } : undefined })
      expect(res.status).toBe(403)
      expect((await res.json()).error).toEqual({ code: 'insufficient_scope', message: 'requires members:write' })
    }
    expect((await k.events()).filter((e) => e.type.startsWith('membership.'))).toHaveLength(0)
  })

  it('keeps the last owner on demotion and removal', async () => {
    const t = await k.seedOrg()
    const oid = await mid(t.ownerId)
    for (const [method, body] of [['PATCH', { role: 'member' }], ['DELETE', undefined]] as const) {
      const res = await k.call(`/memberships/${oid}`, 'o', { method, org: t.organizationId, body })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toEqual({ code: 'last_owner', message: 'an organisation must keep at least one owner' })
    }
    const row = await k.owner.selectFrom('memberships').select(['role', 'deleted_at']).where('id', '=', oid).executeTakeFirstOrThrow()
    expect(row).toEqual({ role: 'owner', deleted_at: null })
    expect((await k.events()).filter((e) => e.type.startsWith('membership.'))).toHaveLength(0)
  })

  it('compares ids case-insensitively', async () => {
    const t = await k.seedOrg()
    const oid = (await mid(t.ownerId)).toUpperCase()
    const res = await k.call(`/memberships/${oid}`, 'o', { method: 'PATCH', org: t.organizationId, body: { role: 'member' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('last_owner')
  })

  it('a second owner frees the first to step down', async () => {
    const t = await k.seedOrg()
    const oid = await mid(t.ownerId)
    await k.call(`/memberships/${await mid(t.memberId)}`, 'o', { method: 'PATCH', org: t.organizationId, body: { role: 'owner' } })
    const res = await k.call(`/memberships/${oid}`, 'o', { method: 'PATCH', org: t.organizationId, body: { role: 'member' } })
    expect(res.status).toBe(200)
    expect((await k.call('/memberships', 'o', { org: t.organizationId })).status).toBe(200)
    const again = await k.call(`/memberships/${oid}`, 'o', { method: 'PATCH', org: t.organizationId, body: { role: 'owner' } })
    expect(again.status).toBe(403)
    expect((await again.json()).error.code).toBe('insufficient_scope')
  })

  it('removes a member, who then loses the organisation', async () => {
    const t = await k.seedOrg()
    const id = await mid(t.memberId)
    const last = await (await k.call(`/memberships/${id}`, 'o', { org: t.organizationId })).json()
    const res = await k.call(`/memberships/${id}`, 'o', { method: 'DELETE', org: t.organizationId })
    expect(res.status).toBe(204)
    const ev = (await k.events()).filter((e) => e.type === 'membership.deleted')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.before).toEqual(last)
    expect(ev[0]!.after).toBeNull()
    const tasks = await k.call('/tasks', 'm')
    expect(tasks.status).toBe(403)
    expect((await tasks.json()).error.code).toBe('organization_required')
    expect((await (await k.call('/me', 'm')).json()).memberships).toEqual([])
  })

  it('concurrent demotions cannot leave no owner', async () => {
    const t = await k.seedOrg()
    await k.call(`/memberships/${await mid(t.memberId)}`, 'o', { method: 'PATCH', org: t.organizationId, body: { role: 'owner' } })
    const ctxOf = (id: string) => ({ actor: { id, kind: 'user' as const }, organizationId: t.organizationId, scopes: ScopeSet.parse(['members:read', 'members:write']) })
    const demote = (target: string) => (ctx: Parameters<Parameters<typeof withContext>[2]>[0]) => updateResource(ctx, memberships, target, { role: 'member' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let t1Updated!: () => void
    const updated = new Promise<void>((r) => (t1Updated = r))
    const t1 = withContext(k.db, ctxOf(t.ownerId), async (ctx) => {
      await demote(await mid(t.memberId))(ctx)
      t1Updated()
      await gate
    })
    await updated
    let t2State = 'pending'
    const t2 = withContext(k.db, ctxOf(t.memberId), demote(await mid(t.ownerId))).then(
      () => (t2State = 'done'),
      (e) => ((t2State = 'failed'), e),
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(t2State).toBe('pending')
    release()
    await t1
    const err = await t2
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'last_owner' })
    const owners = await k.owner.selectFrom('memberships').select('user_id').where('role', '=', 'owner').where('deleted_at', 'is', null).execute()
    expect(owners.map((o) => o.user_id)).toEqual([t.ownerId])
  })
})
