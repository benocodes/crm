import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair } from 'jose'
import { createClerkAdapter, mapClerkRole } from './clerk.js'
import {
  API_URL,
  SECRET_KEY,
  WEBHOOK_SECRET,
  clerkMembership,
  clerkOrganization,
  clerkUser,
  clerkWebhook,
  mintClerkToken,
  orgClaim,
  signClerkWebhook,
  testClerkAdapter,
  testIssuer,
} from '../test/clerk.js'

const NOW = new Date('2026-10-20T12:00:00Z')
const nowS = Math.floor(NOW.getTime() / 1000)
const setup = () => testClerkAdapter({ now: () => NOW })
const mint = async (o: Parameters<typeof mintClerkToken>[1] = {}) => mintClerkToken(await testIssuer(), { now: NOW, ...o })

describe('clerk verify', () => {
  it('valid token', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ sub: 'user_1' }))).toEqual({
      ok: true,
      subject: 'user_1',
      issuedAt: new Date(nowS * 1000),
      organization: null,
    })
  })

  it('missing iat', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ omit: ['iat'] }))).toEqual({ ok: false, reason: 'claims' })
  })

  it('bad signature', async () => {
    const { adapter } = await setup()
    const other = await generateKeyPair('RS256')
    expect(await adapter.verify(await mint({ key: other.privateKey }))).toEqual({ ok: false, reason: 'signature' })
  })

  it('expired beyond skew / within skew', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ exp: nowS - 10 }))).toEqual({ ok: false, reason: 'expired' })
    expect((await adapter.verify(await mint({ exp: nowS - 3 }))).ok).toBe(true)
  })

  it('not yet valid / nbf within skew', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ nbf: nowS + 10 }))).toEqual({ ok: false, reason: 'not_yet_valid' })
    expect((await adapter.verify(await mint({ nbf: nowS + 3 }))).ok).toBe(true)
  })

  it('wrong issuer', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ iss: 'https://evil.example' }))).toEqual({ ok: false, reason: 'issuer' })
  })

  it('azp outside the list, absent, not a string', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ azp: 'https://evil.example' }))).toEqual({ ok: false, reason: 'azp' })
    expect((await adapter.verify(await mint({ azp: undefined }))).ok).toBe(true)
    expect(await adapter.verify(await mint({ azp: 42 }))).toEqual({ ok: false, reason: 'azp' })
  })

  it('missing sub, empty sub, missing exp', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ omit: ['sub'] }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter.verify(await mint({ sub: '' }))).toEqual({ ok: false, reason: 'claims' })
    expect(await adapter.verify(await mint({ omit: ['exp'] }))).toEqual({ ok: false, reason: 'claims' })
  })

  it('HS256 is refused', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ alg: 'HS256' }))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('malformed', async () => {
    const { adapter } = await setup()
    expect(await adapter.verify('a.b.c')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('an escaped PEM (literal \\n) works', async () => {
    const issuer = await testIssuer()
    const adapter = createClerkAdapter({
      jwtKey: issuer.pem.replace(/\n/g, '\\n'),
      issuer: issuer.issuer,
      authorizedParties: [issuer.party],
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      now: () => NOW,
    })
    expect((await adapter.verify(await mint())).ok).toBe(true)
  })

  it('claim admin / member / custom role', async () => {
    const { adapter } = await setup()
    const org = async (rol: string) => {
      const r = await adapter.verify(await mint({ extra: orgClaim('org_x', rol) }))
      return r.ok ? r.organization : r
    }
    expect(await org('admin')).toEqual({ externalId: 'org_x', role: 'owner' })
    expect(await org('member')).toEqual({ externalId: 'org_x', role: 'member' })
    expect(await org('billing')).toEqual({ externalId: 'org_x', role: null })
  })

  it.each([['a string', 'org_x'], ['no id', {}], ['empty id', { id: '' }], ['numeric id', { id: 7 }]])('bad claim: %s', async (_n, o) => {
    const { adapter } = await setup()
    expect(await adapter.verify(await mint({ extra: { o } }))).toEqual({ ok: false, reason: 'claims' })
  })
})

describe('mapClerkRole', () => {
  it.each([
    ['admin', 'owner'],
    ['org:admin', 'owner'],
    ['member', 'member'],
    ['org:member', 'member'],
    ['org:billing', null],
    ['', null],
    [7, null],
    [undefined, null],
  ])('%j -> %j', (input, expected) => {
    expect(mapClerkRole(input)).toBe(expected)
  })
})

describe('clerk fetchOrganization', () => {
  it('200', async () => {
    const t = await testClerkAdapter({ organizations: new Map([['org_x', clerkOrganization({ id: 'org_x', name: 'Acme' })]]) })
    expect(await t.adapter.fetchOrganization('org_x')).toEqual({ externalId: 'org_x', name: 'Acme' })
    expect(t.fetch.calls).toEqual([{ url: `${API_URL}/v1/organizations/org_x`, authorization: `Bearer ${SECRET_KEY}` }])
  })
  it('404', async () => {
    const t = await testClerkAdapter()
    expect(await t.adapter.fetchOrganization('org_nope')).toBeNull()
  })
  it('500', async () => {
    const t = await testClerkAdapter({ organizations: new Map([['org_x', clerkOrganization({ id: 'org_x', name: 'Acme' })]]) })
    t.fetch.fail.organization = 500
    await expect(t.adapter.fetchOrganization('org_x')).rejects.toThrow('clerk organization fetch failed: 500')
  })
})

describe('clerk listMembers', () => {
  const orgs = () => new Map([['org_x', clerkOrganization({ id: 'org_x', name: 'Acme' })]])

  it('pages through every member', async () => {
    const all = Array.from({ length: 205 }, (_v, i) => clerkMembership({ organizationId: 'org_x', userId: `user_${i}`, role: 'org:member' }))
    const t = await testClerkAdapter({ organizations: orgs(), members: new Map([['org_x', all]]) })
    expect(await t.adapter.listMembers('org_x')).toHaveLength(205)
    const urls = t.fetch.calls.map((c) => new URL(c.url))
    expect(urls.map((u) => u.searchParams.get('offset'))).toEqual(['0', '100', '200'])
    expect(urls.every((u) => u.searchParams.get('limit') === '100')).toBe(true)
  })

  it('maps roles and skips what it cannot use', async () => {
    const noUser = clerkMembership({ organizationId: 'org_x', userId: 'ignored', role: 'org:member' })
    ;(noUser.public_user_data as { user_id?: string }).user_id = undefined
    const t = await testClerkAdapter({
      organizations: orgs(),
      members: new Map([
        [
          'org_x',
          [
            clerkMembership({ organizationId: 'org_x', userId: 'a', role: 'org:admin' }),
            clerkMembership({ organizationId: 'org_x', userId: 'b', role: 'org:member' }),
            clerkMembership({ organizationId: 'org_x', userId: 'c', role: 'org:billing' }),
            noUser,
          ],
        ],
      ]),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await t.adapter.listMembers('org_x')).toEqual([
      { subject: 'a', role: 'owner' },
      { subject: 'b', role: 'member' },
    ])
    expect(warn.mock.calls.filter((c) => c[0] === '[directory] member skipped')).toHaveLength(2)
    warn.mockRestore()
  })

  it('failure', async () => {
    const t = await testClerkAdapter()
    await expect(t.adapter.listMembers('org_nope')).rejects.toThrow('clerk membership list failed: 404')
  })
})

describe('clerk parseWebhook', () => {
  const T = 1731705121
  const at = (s: number) => () => new Date(s * 1000)
  const parse = async (signed: { headers: Record<string, string>; body: string }, now = Date.now() / 1000) => {
    const { adapter } = await testClerkAdapter({ now: at(now) })
    return adapter.parseWebhook({ headers: new Headers(signed.headers), body: signed.body })
  }
  const evt = clerkWebhook('organizationMembership.created', { id: 'orgmem_1', organization: { id: 'org_x' } })

  it("Svix's published vector verifies (then fails mapping: no type)", async () => {
    const issuer = await testIssuer()
    const adapter = createClerkAdapter({
      jwtKey: issuer.pem,
      issuer: issuer.issuer,
      authorizedParties: [issuer.party],
      secretKey: SECRET_KEY,
      webhookSecret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
      now: at(T),
    })
    const headers = new Headers({
      'svix-id': 'msg_loFOjxBNrRLzqYUf',
      'svix-timestamp': String(T),
      'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
    })
    expect(await adapter.parseWebhook({ headers, body: '{"event_type":"ping","data":{"success":true}}' })).toEqual({
      ok: false,
      reason: 'payload',
    })
  })

  it('signed membership event', async () => {
    expect(await parse(signClerkWebhook(evt))).toEqual({ ok: true, change: { kind: 'organization', externalId: 'org_x' } })
  })

  it.each([
    ['organization.created', { id: 'org_a' }, { kind: 'organization', externalId: 'org_a' }],
    ['organization.updated', { id: 'org_a' }, { kind: 'organization', externalId: 'org_a' }],
    ['organization.deleted', { id: 'org_a' }, { kind: 'organization', externalId: 'org_a' }],
    ['user.updated', { id: 'user_a' }, { kind: 'user', subject: 'user_a' }],
    ['session.created', { id: 'sess_a' }, { kind: 'ignored', type: 'session.created' }],
  ])('maps %s', async (type, data, change) => {
    expect(await parse(signClerkWebhook(clerkWebhook(type, data)))).toEqual({ ok: true, change })
  })

  it('headers', async () => {
    for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const signed = signClerkWebhook(evt)
      delete signed.headers[name]
      expect(await parse(signed), name).toEqual({ ok: false, reason: 'headers' })
    }
    const empty = signClerkWebhook(evt)
    empty.headers['svix-id'] = ''
    expect(await parse(empty)).toEqual({ ok: false, reason: 'headers' })
  })

  it('timestamp', async () => {
    const now = 1_800_000_000
    expect(await parse(signClerkWebhook(evt, { timestamp: now - 301 }), now)).toEqual({ ok: false, reason: 'timestamp' })
    expect(await parse(signClerkWebhook(evt, { timestamp: now + 301 }), now)).toEqual({ ok: false, reason: 'timestamp' })
    expect((await parse(signClerkWebhook(evt, { timestamp: now - 299 }), now)).ok).toBe(true)
    const nan = signClerkWebhook(evt, { timestamp: now })
    nan.headers['svix-timestamp'] = 'soon'
    expect(await parse(nan, now)).toEqual({ ok: false, reason: 'timestamp' })
  })

  it('signature', async () => {
    const wrongSecret = 'whsec_' + Buffer.alloc(32, 9).toString('base64')
    expect(await parse(signClerkWebhook(evt, { secret: wrongSecret }))).toEqual({ ok: false, reason: 'signature' })
    const tampered = signClerkWebhook(evt)
    tampered.body = tampered.body.replace('org_x', 'org_y')
    expect(await parse(tampered)).toEqual({ ok: false, reason: 'signature' })
    const v2 = signClerkWebhook(evt)
    v2.headers['svix-signature'] = v2.headers['svix-signature']!.replace(/^v1,/, 'v2,')
    expect(await parse(v2)).toEqual({ ok: false, reason: 'signature' })
  })

  it('several signatures, one good', async () => {
    const signed = signClerkWebhook(evt)
    signed.headers['svix-signature'] = `v1,${Buffer.alloc(32, 1).toString('base64')} ${signed.headers['svix-signature']}`
    expect((await parse(signed)).ok).toBe(true)
  })

  it('payload', async () => {
    expect(await parse(signClerkWebhook('not json'))).toEqual({ ok: false, reason: 'payload' })
    expect(await parse(signClerkWebhook('{"type":"organization.created","data":{}}'))).toEqual({ ok: false, reason: 'payload' })
  })
})

describe('clerk fetchProfile', () => {
  const withUser = async (u: ReturnType<typeof clerkUser>) =>
    (await testClerkAdapter({ profiles: new Map([[u.id, u]]), now: () => NOW })).adapter

  it('primary verified', async () => {
    const a = await withUser(clerkUser({ id: 'user_1', email: 'a@x.test', verified: true, first: 'Ada', last: 'L' }))
    expect(await a.fetchProfile('user_1')).toEqual({ email: 'a@x.test', emailVerified: true, name: 'Ada L' })
  })

  it('primary unverified', async () => {
    const a = await withUser(clerkUser({ id: 'user_1', email: 'a@x.test', verified: false }))
    expect((await a.fetchProfile('user_1')).emailVerified).toBe(false)
  })

  it('the primary address is chosen', async () => {
    const u = clerkUser({ id: 'user_1', email: 'first@x.test' })
    u.email_addresses = [
      { ...u.email_addresses[0]!, id: 'idn_a', email_address: 'first@x.test' },
      { ...u.email_addresses[0]!, id: 'idn_b', email_address: 'second@x.test' },
    ]
    u.primary_email_address_id = 'idn_b'
    expect((await (await withUser(u)).fetchProfile('user_1')).email).toBe('second@x.test')
  })

  it('no email', async () => {
    const a = await withUser(clerkUser({ id: 'user_1', email: null, first: 'Ada', last: null }))
    expect(await a.fetchProfile('user_1')).toEqual({ email: null, emailVerified: false, name: 'Ada' })
  })

  it('name parts', async () => {
    const name = async (first: string | null, last: string | null) =>
      (await (await withUser(clerkUser({ id: 'u', email: 'a@x.test', first, last }))).fetchProfile('u')).name
    expect(await name('Ada', null)).toBe('Ada')
    expect(await name(null, null)).toBeNull()
  })

  it('request shape', async () => {
    const t = await testClerkAdapter({ profiles: new Map([['user_a/b', clerkUser({ id: 'user_a/b', email: 'a@x.test' })]]) })
    await t.adapter.fetchProfile('user_a/b')
    expect(t.fetch.calls).toEqual([{ url: `${API_URL}/v1/users/user_a%2Fb`, authorization: `Bearer ${SECRET_KEY}` }])
  })

  it('HTTP error', async () => {
    const t = await testClerkAdapter({ profiles: new Map() })
    await expect(t.adapter.fetchProfile('nobody')).rejects.toThrow('clerk profile fetch failed: 404')
  })
})
