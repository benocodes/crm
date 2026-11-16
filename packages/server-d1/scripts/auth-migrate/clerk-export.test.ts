import { describe, expect, it } from 'vitest'
import { exportClerkUsers } from './clerk-export.js'
import { CLERK_SECRET, fakeClerk, recordedClerkUsers, standardClerk } from './test-kit.js'

// [[OPS365]] group 2: the Clerk export reads every user, correctly. The bodies are a response recorded on the Clerk dev instance (scrubbed); the fake serves two users a page.
describe('the Clerk export', () => {
  it('pages past one page: every user comes back, in order', async () => {
    const clerk = fakeClerk(standardClerk(), 2)
    const users = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: clerk.fetch })
    expect(users.map((u) => u.id)).toEqual([
      'user_scrubbeda',
      'user_scrubbedb',
      'user_scrubbedc',
      'user_scrubbedd',
      'user_scrubbede',
      'user_scrubbedf',
    ])
    // three full pages, then the empty one that ends it; the offset advances by what each page held
    expect(clerk.calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '2', '4', '6'])
    expect(clerk.calls.every((c) => new URL(c.url).searchParams.get('order_by') === 'created_at')).toBe(true)
  })

  it('takes the email from primary_email_address_id, not the first address', async () => {
    const recorded = recordedClerkUsers()
    const two = recorded[1]!
    expect(two.email_addresses[0].email_address).toBe('b2@example.test') // the recorded response lists the primary second
    const users = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: fakeClerk([two], 10).fetch })
    expect(users[0]).toMatchObject({ id: 'user_scrubbedb', email: 'b@example.test', email_verified: true })
  })

  it('takes the verified flag from the primary address, not from another one', async () => {
    const u = structuredClone(recordedClerkUsers()[1]!)
    const primary = u.email_addresses.find((e: any) => e.id === u.primary_email_address_id)
    const other = u.email_addresses.find((e: any) => e.id !== u.primary_email_address_id)
    primary.verification = { status: 'unverified' }
    other.verification = { status: 'verified' }
    const users = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: fakeClerk([u], 10).fetch })
    expect(users[0]).toMatchObject({ email: 'b@example.test', email_verified: false })
  })

  it('has no email and is not verified when the user has no primary address', async () => {
    const u = structuredClone(recordedClerkUsers()[0]!)
    u.primary_email_address_id = null
    const users = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: fakeClerk([u], 10).fetch })
    expect(users[0]).toMatchObject({ email: null, email_verified: false })
  })

  it('takes the role from public_metadata.vibase_role; a missing or non-string role is null', async () => {
    const [a, b, c, d] = recordedClerkUsers()
    const odd = structuredClone(a!)
    odd.public_metadata = { vibase_role: 7 }
    const users = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: fakeClerk([a!, b!, c!, d!, odd], 10).fetch })
    expect(users.map((u) => u.role)).toEqual(['owner', 'member', 'agent', null, null])
  })

  it('sends the secret only as the Authorization header, and only GETs', async () => {
    const clerk = fakeClerk(standardClerk(), 2)
    await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: clerk.fetch })
    expect(clerk.calls.length).toBeGreaterThan(0)
    for (const c of clerk.calls) {
      expect(c.method).toBe('GET')
      expect(c.authorization).toBe(`Bearer ${CLERK_SECRET}`)
      expect(c.url).not.toContain(CLERK_SECRET)
      expect(new URL(c.url).origin).toBe('https://api.clerk.com')
    }
  })

  it('a failed page throws without the secret in the message', async () => {
    const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const err = await exportClerkUsers({ secretKey: CLERK_SECRET, fetch: failing }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('401')
    expect((err as Error).message).not.toContain(CLERK_SECRET)
  })

  it('a body that is not a list of users throws', async () => {
    const odd = (async () => new Response(JSON.stringify({ errors: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(exportClerkUsers({ secretKey: CLERK_SECRET, fetch: odd })).rejects.toThrow(/unexpected/)
  })
})
