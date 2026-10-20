import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { useAdminKit } from '../test/admin-kit.js'

const k = useAdminKit()
const post = (sub: string, org: string, body: unknown) => k.call('/invitations', sub, { method: 'POST', org, body })
const DAY = 86_400_000

describe('invitations create and delete', () => {
  it('creates a normalised, expiring invitation and emits', async () => {
    const t = await k.seedOrg()
    const res = await post('o', t.organizationId, { email: 'New@X.test', role: 'member' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ email: 'new@x.test', role: 'member', accepted_at: null, accepted_by: null, organization_id: t.organizationId })
    expect(Date.parse(body.expires_at) - Date.parse(body.created_at)).toBe(14 * DAY)
    const events = (await k.events()).filter((e) => e.type === 'invitation.created')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor_id: t.ownerId, organization_id: t.organizationId, resource_id: body.id })
    expect(events[0]!.after).toEqual(body)
  })

  it('refuses a second pending invitation, in any case', async () => {
    const t = await k.seedOrg()
    await post('o', t.organizationId, { email: 'new@x.test', role: 'member' })
    const res = await post('o', t.organizationId, { email: 'NEW@x.test', role: 'owner' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toEqual({ code: 'invitation_exists', message: 'a pending invitation for new@x.test already exists' })
    expect(await k.owner.selectFrom('invitations').selectAll().execute()).toHaveLength(1)
    expect((await k.events()).filter((e) => e.type.startsWith('invitation.'))).toHaveLength(1)
  })

  it('replaces an expired invitation', async () => {
    const t = await k.seedOrg()
    const first = await (await post('o', t.organizationId, { email: 'new@x.test', role: 'member' })).json()
    await k.owner.updateTable('invitations').set({ expires_at: sql`now() - interval '1 day'` }).execute()
    const res = await post('o', t.organizationId, { email: 'new@x.test', role: 'member' })
    expect(res.status).toBe(201)
    const second = await res.json()
    const old = await k.owner.selectFrom('invitations').select('deleted_at').where('id', '=', first.id).executeTakeFirstOrThrow()
    expect(old.deleted_at).not.toBeNull()
    const events = (await k.events()).filter((e) => e.type.startsWith('invitation.'))
    expect(events.map((e) => [e.type, e.resource_id])).toEqual([
      ['invitation.created', first.id],
      ['invitation.deleted', first.id],
      ['invitation.created', second.id],
    ])
    expect(events[1]).toMatchObject({ actor_id: t.ownerId })
    expect(events[1]!.before.id).toBe(first.id)
  })

  it('an accepted invitation frees the slot', async () => {
    const t = await k.seedOrg()
    await post('o', t.organizationId, { email: 'new@x.test', role: 'member' })
    await k.owner.updateTable('invitations').set({ accepted_at: sql`now()`, accepted_by: t.memberId }).execute()
    expect((await post('o', t.organizationId, { email: 'new@x.test', role: 'member' })).status).toBe(201)
  })

  it('concurrent creates: one wins', async () => {
    const t = await k.seedOrg()
    const results = await Promise.all([1, 2].map(() => post('o', t.organizationId, { email: 'race@x.test', role: 'member' })))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    const loser = results.find((r) => r.status === 409)!
    expect((await loser.json()).error.code).toBe('invitation_exists')
    expect(await k.owner.selectFrom('invitations').selectAll().where('deleted_at', 'is', null).execute()).toHaveLength(1)
  })

  it('a member cannot write but can read', async () => {
    const t = await k.seedOrg()
    const res = await post('m', t.organizationId, { email: 'x@x.test', role: 'member' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toEqual({ code: 'insufficient_scope', message: 'requires members:write' })
    expect(await k.owner.selectFrom('invitations').selectAll().execute()).toHaveLength(0)
    const created = await (await post('o', t.organizationId, { email: 'x@x.test', role: 'member' })).json()
    const list = await (await k.call('/invitations', 'm', { org: t.organizationId })).json()
    expect(list.data.map((i: { id: string }) => i.id)).toContain(created.id)
  })

  it.each([
    [{ email: 'x@x.test', role: 'admin' }],
    [{ email: 'nope', role: 'member' }],
    [{ email: 'x@x.test', role: 'member', extra: 1 }],
  ])('rejects the body %j', async (body) => {
    const t = await k.seedOrg()
    const res = await post('o', t.organizationId, body)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_error')
  })

  it('deletes', async () => {
    const t = await k.seedOrg()
    const inv = await (await post('o', t.organizationId, { email: 'x@x.test', role: 'member' })).json()
    const res = await k.call(`/invitations/${inv.id}`, 'o', { method: 'DELETE', org: t.organizationId })
    expect(res.status).toBe(204)
    expect((await k.events()).map((e) => e.type)).toContain('invitation.deleted')
    expect((await k.call(`/invitations/${inv.id}`, 'o', { org: t.organizationId })).status).toBe(404)
  })

  it('refuses an agent without members scopes', async () => {
    const t = await k.seedOrg()
    const agent = await k.seedKeyedAgent(t.organizationId, t.ownerId, ['tasks:read', 'tasks:write'])
    const res = await k.keyCall('/invitations', agent.key)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('insufficient_scope')
  })
})
