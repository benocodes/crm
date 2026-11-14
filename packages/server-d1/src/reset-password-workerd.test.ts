import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { passwordResetUrl } from '@vibase/api'

// [[UI246]] D6 in workerd: a token issued by Better Auth's OWN reset request, through a TEST composition that spreads the real composition's options and adds a capturing
// `sendResetPassword` (auth/src/test/reset-entry.ts; the shipped composition has none), sets the new password through `POST /auth/reset-password`.
const ENTRY = fileURLToPath(new URL('../../auth/src/test/reset-entry.ts', import.meta.url))
const OLD = 'the old password 123'
const NEW = 'the brand new password 456'

let bundle: Bundle
const started: Workerd[] = []
let ip = 0
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
}, 120_000)
afterAll(async () => {
  for (const w of started) await w.dispose()
  bundle?.dispose()
})
const start = async (bindings: Record<string, string> = {}) => {
  const w = await startWorkerd({ bundle, bindings })
  started.push(w)
  return w
}
/** Better Auth limits sign-in and sign-up per IP; every call here comes from its own address (CORE287). */
const call = (w: Workerd, path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) => w.call(path, { ...init, headers: { 'cf-connecting-ip': `198.51.100.${(ip++ % 250) + 1}` } })
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!
const sessionOf = async (w: Workerd, cookie: string) => (await (await call(w, '/auth/get-session', { cookie })).json()) as { user?: { email: string } } | null

/** An account with two browser sessions, and a reset token Better Auth issued for it. */
async function account(w: Workerd, email: string) {
  const up = await call(w, '/auth/sign-up/email', { body: { name: 'Reset Person', email, password: OLD } })
  expect(up.status, await up.clone().text()).toBe(200)
  const first = cookieOf(up)
  const inRes = await call(w, '/auth/sign-in/email', { body: { email, password: OLD } })
  expect(inRes.status).toBe(200)
  const second = cookieOf(inRes)
  const req = await call(w, '/auth/request-password-reset', { body: { email } })
  expect(req.status, await req.clone().text()).toBe(200)
  const issued = (await (await call(w, '/__resets')).json()) as Array<{ token: string; email: string }>
  const token = issued.filter((r) => r.email === email).at(-1)!.token
  return { first, second, token }
}

describe('a Better Auth-issued reset token (test composition)', () => {
  it('sets the new password: the new one signs in, the old is refused, every existing session is gone, the token is single-use', async () => {
    const w = await start({ OPEN_ADMISSION: '1' })
    const { first, second, token } = await account(w, 'reset@auth.test')
    expect((await sessionOf(w, first))?.user?.email).toBe('reset@auth.test')
    expect((await sessionOf(w, second))?.user?.email).toBe('reset@auth.test')

    const done = await call(w, '/auth/reset-password', { body: { newPassword: NEW, token } })
    expect(done.status, await done.clone().text()).toBe(200)

    expect((await call(w, '/auth/sign-in/email', { body: { email: 'reset@auth.test', password: NEW } })).status).toBe(200)
    expect((await call(w, '/auth/sign-in/email', { body: { email: 'reset@auth.test', password: OLD } })).status).toBe(401)
    // revokeSessionsOnPasswordReset: the user's sessions from before the reset do not survive it.
    expect(await sessionOf(w, first)).toBeNull()
    expect(await sessionOf(w, second)).toBeNull()

    const again = await call(w, '/auth/reset-password', { body: { newPassword: 'another password 789', token } })
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('an unknown token is INVALID_TOKEN', async () => {
    const w = await start({ OPEN_ADMISSION: '1' })
    const res = await call(w, '/auth/reset-password', { body: { newPassword: NEW, token: 'bogus' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('a too-short new password is refused with PASSWORD_TOO_SHORT and the token is still usable', async () => {
    const w = await start({ OPEN_ADMISSION: '1' })
    const { token } = await account(w, 'short@auth.test')
    const res = await call(w, '/auth/reset-password', { body: { newPassword: 'short', token } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' })
    expect((await call(w, '/auth/reset-password', { body: { newPassword: NEW, token } })).status).toBe(200)
  })

  it('the reset-link builder makes <base>/reset-password#token=<token> from the captured token, base with and without a trailing slash', async () => {
    const w = await start({ OPEN_ADMISSION: '1' })
    const { token } = await account(w, 'link@auth.test')
    expect(passwordResetUrl(BASE, token)).toBe(`${BASE}/reset-password#token=${token}`)
    expect(passwordResetUrl(`${BASE}/`, token)).toBe(`${BASE}/reset-password#token=${token}`)
    expect(new URL(passwordResetUrl(BASE, token)).hash).toBe(`#token=${token}`)
  })
})

describe('the shipped composition', () => {
  it('still refuses /auth/request-password-reset (no sendResetPassword) and issues nothing', async () => {
    const w = await start({ OPEN_ADMISSION: '1', SHIPPED: '1' })
    const up = await call(w, '/auth/sign-up/email', { body: { name: 'Shipped', email: 'shipped@auth.test', password: OLD } })
    expect(up.status).toBe(200)
    const res = await call(w, '/auth/request-password-reset', { body: { email: 'shipped@auth.test' } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await w.controlRows('select identifier from auth_verifications')).toEqual([])
  })
})
