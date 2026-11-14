import { describe, expect, it } from 'vitest'
import { INVITATION_REQUIRED, authOptions, type InvitationAdmission } from './index.js'

// [[CORE287]] P2: the backstop at the point every account creation passes (`databaseHooks.user.create.before`), called directly so the endpoint hook cannot be what refuses.
const admission: InvitationAdmission = { admits: async (a) => a.email === 'ann@x.test' && a.token === 'tok', settle: async () => undefined }
const config = { secret: 'x'.repeat(32), baseURL: 'https://vibase.test' }
const db = { prepare: () => undefined }
const backstop = (opts: Parameters<typeof authOptions>[2]) => (authOptions(db, config, opts).databaseHooks!.user!.create!.before as unknown as (user: unknown, ctx: unknown) => Promise<unknown>)
const user = { email: 'ann@x.test' }

describe('the user-creation backstop', () => {
  const gated = backstop({ admission })
  it.each([
    ['no body', undefined],
    ['no token', { email: 'ann@x.test' }],
    ['a wrong token', { email: 'ann@x.test', invitation_token: 'nope' }],
    ['another email', { email: 'bob@x.test', invitation_token: 'tok' }],
  ])('%s: rejects with 403 invitation_required', async (_n, body) => {
    const err = await gated(user, { body }).then(() => null, (e: { statusCode?: number; body?: { code?: string } }) => e)
    expect([err?.statusCode, err?.body?.code]).toEqual([403, INVITATION_REQUIRED])
  })
  it('the matching email (differently cased) and token resolves', async () => {
    await expect(gated(user, { body: { email: 'Ann@X.test', invitation_token: 'tok' } })).resolves.toBeUndefined()
  })
  it('with no port and no test switch it rejects; with the test switch it resolves with no body', async () => {
    await expect(backstop({})(user, { body: { email: 'ann@x.test', invitation_token: 'tok' } })).rejects.toMatchObject({ statusCode: 403 })
    await expect(backstop({ unsafeOpenAdmissionForTests: true })(user, undefined)).resolves.toBeUndefined()
  })
})
