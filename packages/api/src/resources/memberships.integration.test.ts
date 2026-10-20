import { describe, expect, it } from 'vitest'
import { useAdminKit } from '../test/admin-kit.js'
import { membershipRecord } from '../account/organizations.js'

const k = useAdminKit()
const mid = async (userId: string) =>
  (await k.owner.selectFrom('memberships').select('id').where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id

describe('memberships (read-only: the directory sync is the only writer)', () => {
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

  it('a member reads one', async () => {
    const t = await k.seedOrg()
    const res = await k.call(`/memberships/${await mid(t.ownerId)}`, 'm', { org: t.organizationId })
    expect(res.status).toBe(200)
    membershipRecord.parse(await res.json())
  })

  it('PATCH and DELETE have no route', async () => {
    const t = await k.seedOrg()
    const id = await mid(t.memberId)
    for (const [method, body] of [['PATCH', { role: 'owner' }], ['DELETE', undefined]] as const) {
      const res = await k.call(`/memberships/${id}`, 'o', { method, org: t.organizationId, body })
      expect(res.status, method).toBe(404)
      expect((await res.json()).error.code).toBe('not_found')
    }
    expect((await k.events()).filter((e) => e.type.startsWith('membership.'))).toHaveLength(0)
  })
})
