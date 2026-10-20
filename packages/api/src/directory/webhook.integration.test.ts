import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../rest/app.js'
import { fakeUserAuthenticator } from '../test/user-auth.js'
import { useAdminKit } from '../test/admin-kit.js'
import { clerkMembership, clerkUser, clerkWebhook } from '../test/clerk.js'

const k = useAdminKit()
const membershipEvent = (type: string, externalId: string, userId = 'x') =>
  clerkWebhook(type, { id: `orgmem_${userId}`, organization: { id: externalId }, public_user_data: { user_id: userId } })
const liveSubs = async (organizationId: string) =>
  (
    await k.owner
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('users.auth_subject')
      .where('memberships.organization_id', '=', organizationId)
      .where('memberships.deleted_at', 'is', null)
      .orderBy('users.auth_subject')
      .execute()
  ).map((r) => r.auth_subject)
const addB = (t: { externalId: string }) => {
  k.profile('b')
  k.clerk.members.get(t.externalId)!.push(clerkMembership({ organizationId: t.externalId, userId: 'b', role: 'org:member' }))
}

describe('POST /webhooks/clerk', () => {
  it('reconciles on a membership change', async () => {
    const t = await k.seedOrg()
    addB(t)
    const res = await k.webhook(membershipEvent('organizationMembership.created', t.externalId, 'b'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(await liveSubs(t.organizationId)).toEqual(['b', 'm', 'o'])
  })

  it('applies a removal', async () => {
    const t = await k.seedOrg()
    k.clerk.members.set(t.externalId, k.clerk.members.get(t.externalId)!.filter((m) => m.public_user_data.user_id !== 'm'))
    expect((await k.webhook(membershipEvent('organizationMembership.deleted', t.externalId, 'm'))).status).toBe(200)
    expect(await liveSubs(t.organizationId)).toEqual(['o'])
  })

  it('a duplicate delivery changes nothing', async () => {
    const t = await k.seedOrg()
    addB(t)
    const payload = membershipEvent('organizationMembership.created', t.externalId, 'b')
    await k.webhook(payload)
    const before = (await k.events()).length
    expect((await k.webhook(payload)).status).toBe(200)
    expect((await k.events()).length).toBe(before)
  })

  it('out-of-order deliveries each fetch current state', async () => {
    const t = await k.seedOrg()
    // Clerk's state: b is not a member (removed). A stale "created" arrives after the "deleted".
    await k.webhook(membershipEvent('organizationMembership.deleted', t.externalId, 'b'))
    await k.webhook(membershipEvent('organizationMembership.created', t.externalId, 'b'))
    expect(await liveSubs(t.organizationId)).toEqual(['m', 'o'])
  })

  it('user.updated refreshes the profile', async () => {
    await k.seedOrg()
    k.profiles.set('o', clerkUser({ id: 'o', email: 'new-o@x.test', verified: true, first: 'Ada', last: 'L' }))
    const res = await k.webhook(clerkWebhook('user.updated', { id: 'o' }))
    expect(res.status).toBe(200)
    const row = await k.owner.selectFrom('users').select('email').where('auth_subject', '=', 'o').executeTakeFirstOrThrow()
    expect(row.email).toBe('new-o@x.test')
  })

  it('ignores other types, without calling Clerk', async () => {
    await k.seedOrg()
    k.clerk.fetch.reset()
    const before = (await k.events()).length
    const res = await k.webhook(clerkWebhook('session.created', { id: 'sess_1' }))
    expect(res.status).toBe(200)
    expect(k.clerk.fetch.calls).toHaveLength(0)
    expect((await k.events()).length).toBe(before)
  })

  it('refuses a bad signature, a stale timestamp and missing headers', async () => {
    const t = await k.seedOrg()
    addB(t)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = membershipEvent('organizationMembership.created', t.externalId, 'b')
    const cases: [Response, string][] = [
      [await k.webhook(payload, { secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') }), 'signature'],
      [await k.webhook(payload, { timestamp: Math.floor(Date.now() / 1000) - 400 }), 'timestamp'],
      [await k.webhook(payload, { headers: { 'svix-id': undefined } }), 'headers'],
    ]
    for (const [res, reason] of cases) {
      expect(res.status, reason).toBe(401)
      expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'invalid webhook signature' } })
      expect(warn).toHaveBeenCalledWith('[directory] webhook 401', { reason })
    }
    expect(await liveSubs(t.organizationId)).toEqual(['m', 'o'])
    warn.mockRestore()
  })

  it('a directory failure is a 500, so Clerk retries', async () => {
    const t = await k.seedOrg()
    k.clerk.fetch.fail.members = 500
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = (await k.events()).length
    const res = await k.webhook(membershipEvent('organizationMembership.created', t.externalId, 'b'))
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('internal')
    expect((await k.events()).length).toBe(before)
  })

  it('is not in the OpenAPI document', async () => {
    const doc = (await (await k.app.request('/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths).some((p) => p.includes('webhooks'))).toBe(false)
  })

  it('does not exist without an adapter', async () => {
    const app = createApp({ db: () => k.db, userAuthenticator: fakeUserAuthenticator() })
    const res = await app.request('/webhooks/clerk', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })
})
