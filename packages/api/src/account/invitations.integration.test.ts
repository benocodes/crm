import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { useAdminKit } from '../test/admin-kit.js'
import { membershipRecord } from './organizations.js'

const k = useAdminKit()

/** Org A (owner `o`, member `m`) and invitee `u` (verified unless told otherwise). */
async function setup(opts: { verified?: boolean; email?: string } = {}) {
  const t = await k.seedOrg('A')
  const email = k.profile('u', { verified: opts.verified ?? true, email: opts.email ?? 'u@x.test' })
  return { ...t, email }
}
async function invite(org: string, email: string, role: 'owner' | 'member' = 'member', sub = 'o') {
  const res = await k.call('/invitations', sub, { method: 'POST', org, body: { email, role } })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}
const accept = (sub: string, id: string) => k.call(`/invitations/${id}/accept`, sub, { method: 'POST' })
const errorOf = async (res: Response) => (await res.json()).error as { code: string; message: string }
const events = async (prefix?: string) => (await k.events()).filter((e) => !prefix || e.type.startsWith(prefix))
const liveMemberships = async (org: string) =>
  k.owner.selectFrom('memberships').selectAll().where('organization_id', '=', org).where('deleted_at', 'is', null).execute()

describe('invitations.accept', () => {
  it('makes the caller a member and emits', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    const before = (await k.events()).length
    const res = await accept('u', inv.id)
    expect(res.status).toBe(200)
    const m = membershipRecord.parse(await res.json())
    const uid = await k.userId('u')
    expect(m).toMatchObject({ organization_id: t.organizationId, user_id: uid, role: 'member', created_by: uid })
    const ev = (await k.events()).slice(before)
    expect(ev.map((e) => e.type)).toEqual(['invitation.accepted', 'membership.created'])
    expect(ev[0]!.before.accepted_at).toBeNull()
    expect(ev[0]!.after).toMatchObject({ accepted_by: uid })
    expect(ev[0]!.after.accepted_at).not.toBeNull()
    for (const e of ev) expect(e).toMatchObject({ actor_id: uid, organization_id: t.organizationId })
  })

  it('is then usable without a header', async () => {
    const t = await setup()
    await accept('u', (await invite(t.organizationId, t.email)).id)
    expect((await k.call('/tasks', 'u')).status).toBe(200)
  })

  it('grants the invited role', async () => {
    const t = await setup()
    const m = await (await accept('u', (await invite(t.organizationId, t.email, 'owner')).id)).json()
    expect(m.role).toBe('owner')
    expect((await (await k.call('/me', 'u')).json()).active_organization.role).toBe('owner')
  })

  it('matches the email case-insensitively', async () => {
    const t = await setup({ email: 'U@X.test' })
    expect((await accept('u', (await invite(t.organizationId, 'u@x.test')).id)).status).toBe(200)
  })

  it('answers 404 for another email, and writes nothing', async () => {
    const t = await setup()
    k.profile('u2', { email: 'u2@x.test' })
    const inv = await invite(t.organizationId, t.email)
    const n = (await k.events()).length
    const res = await accept('u2', inv.id)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('not_found')
    expect((await k.events()).length).toBe(n)
    expect(await liveMemberships(t.organizationId)).toHaveLength(2)
    const row = await k.owner.selectFrom('invitations').select('accepted_at').executeTakeFirstOrThrow()
    expect(row.accepted_at).toBeNull()
  })

  it('refuses an unverified email', async () => {
    const t = await setup({ verified: false })
    const inv = await invite(t.organizationId, t.email)
    const n = (await k.events()).length
    const res = await accept('u', inv.id)
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toEqual({ code: 'email_unverified', message: 'verify your email address to accept an invitation' })
    expect((await k.events()).length).toBe(n)
    expect(await liveMemberships(t.organizationId)).toHaveLength(2)
  })

  it('answers 404 for an expired invitation', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    await k.owner.updateTable('invitations').set({ expires_at: sql`now() - interval '1 day'` }).execute()
    expect((await accept('u', inv.id)).status).toBe(404)
  })

  it('answers 404 for a deleted invitation', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    await k.call(`/invitations/${inv.id}`, 'o', { method: 'DELETE', org: t.organizationId })
    expect((await accept('u', inv.id)).status).toBe(404)
  })

  it('answers 404 for an unknown id and 400 for a bad one', async () => {
    await setup()
    k.profile('u')
    expect((await accept('u', '0190b2c4-0000-7000-8000-00000000dead')).status).toBe(404)
    const bad = await accept('u', 'nope')
    expect(bad.status).toBe(400)
    expect((await errorOf(bad)).code).toBe('validation_error')
  })

  it('replays: the same membership, no new events', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    const first = await (await accept('u', inv.id)).json()
    const n = (await k.events()).length
    const res = await accept('u', inv.id)
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(first.id)
    expect((await k.events()).length).toBe(n)
  })

  it('answers 404 once the accepted member was removed', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    const m = await (await accept('u', inv.id)).json()
    await k.call(`/memberships/${m.id}`, 'o', { method: 'DELETE', org: t.organizationId })
    expect((await accept('u', inv.id)).status).toBe(404)
  })

  it('keeps the role of an existing member', async () => {
    const t = await setup()
    const mEmail = 'm@x.test'
    const inv = await invite(t.organizationId, mEmail, 'owner')
    const n = (await k.events()).length
    const res = await accept('m', inv.id)
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('member')
    const ev = (await k.events()).slice(n)
    expect(ev.map((e) => e.type)).toEqual(['invitation.accepted'])
    expect(await liveMemberships(t.organizationId)).toHaveLength(2)
  })

  it('concurrent accepts make one membership and one event each', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    const [a, b] = await Promise.all([accept('u', inv.id), accept('u', inv.id)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await a.json()).id).toBe((await b.json()).id)
    expect(await liveMemberships(t.organizationId)).toHaveLength(3)
    expect((await events('membership.created')).length).toBe(1)
    expect((await events('invitation.accepted')).length).toBe(1)
  })

  it('lets a removed member join again with a new membership', async () => {
    const t = await setup()
    const first = await (await accept('u', (await invite(t.organizationId, t.email)).id)).json()
    await k.call(`/memberships/${first.id}`, 'o', { method: 'DELETE', org: t.organizationId })
    const again = await accept('u', (await invite(t.organizationId, t.email)).id)
    expect(again.status).toBe(200)
    const m = await again.json()
    expect(m.id).not.toBe(first.id)
    expect((await liveMemberships(t.organizationId)).map((r) => r.id)).toContain(m.id)
  })

  it('is for users only', async () => {
    const t = await setup()
    const inv = await invite(t.organizationId, t.email)
    const agent = await k.seedKeyedAgent(t.organizationId, t.ownerId, ['tasks:read'])
    const res = await k.keyCall(`/invitations/${inv.id}/accept`, agent.key, { method: 'POST' })
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('user_required')
  })
})

describe('me.get invitations', () => {
  it('lists the pending ones addressed to a verified caller', async () => {
    const a = await setup()
    const b = await k.seedOrg('B', { owner: 'bo', member: 'bm' })
    const invA = await invite(a.organizationId, a.email)
    const invB = await invite(b.organizationId, a.email, 'owner', 'bo')
    // an expired, a deleted, an accepted, one for another email
    const expired = await invite(a.organizationId, 'ex@x.test')
    const deleted = await invite(a.organizationId, 'de@x.test')
    const other = await invite(a.organizationId, 'other@x.test')
    await k.owner.updateTable('invitations').set({ expires_at: sql`now() - interval '1 day'` }).where('id', '=', expired.id).execute()
    await k.call(`/invitations/${deleted.id}`, 'o', { method: 'DELETE', org: a.organizationId })
    k.profile('ac', { email: 'ac@x.test' })
    const accepted = await invite(a.organizationId, 'ac@x.test')
    await accept('ac', accepted.id)
    void other
    const body = await (await k.call('/me', 'u')).json()
    const expected = [invA, invB].map((i) => i.id).sort()
    expect(body.invitations.map((i: { id: string }) => i.id)).toEqual(expected)
    for (const i of body.invitations) {
      expect(Object.keys(i).sort()).toEqual(['expires_at', 'id', 'organization_id', 'organization_name', 'role'])
    }
    const first = body.invitations.find((i: { id: string }) => i.id === invB.id)
    expect(first).toMatchObject({ organization_id: b.organizationId, organization_name: 'B', role: 'owner' })
  })

  it('is empty for an unverified caller', async () => {
    const t = await setup({ verified: false })
    await invite(t.organizationId, t.email)
    const body = await (await k.call('/me', 'u')).json()
    expect(body.invitations).toEqual([])
  })
})
