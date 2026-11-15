import { fileURLToPath } from 'node:url'
import { BASE, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// [[CORE304]] D4, D6 in workerd: the REAL Worker module (src/worker.ts through test/entry-email.ts) with a recording `EMAIL` binding. The send is scheduled with `cloudflare:workers`' `waitUntil` (the module-level export
// the Worker entry injects), the recorded link completes a reset, and the Worker's own log holds no address or token.
const ENTRY = fileURLToPath(new URL('./test/entry-email.ts', import.meta.url))
const OLD = 'the old password 123'
const NEW = 'the brand new password 456'
const EMAIL = 'ann@auth.test'

let bundle: Bundle
let w: Workerd
let ip = 0
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({
    bundle,
    paired: true,
    bindings: {
      AUTH_PROVIDER: 'better-auth',
      AUTH_EMAIL_FROM: 'noreply@vibase.test',
      SIGNUP_OPEN: '1',
    },
  })
}, 120_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})
const call = (path: string, init: { body?: unknown; cookie?: string; method?: string } = {}) =>
  w.call(path, { ...init, headers: { origin: BASE, 'cf-connecting-ip': `198.51.100.${(ip++ % 250) + 1}` } })
const emails = async () => (await (await w.call('/__emails')).json()) as Array<Record<string, any>>
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; i < 50; i++) {
    const v = await read()
    if (ok(v)) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return read()
}

describe('self-service reset in workerd (email on)', () => {
  it('discovery says self_service_reset; a request is answered at once and the message is sent after the response through waitUntil', async () => {
    const doc = (await (await w.call('/.well-known/vibase')).json()) as any
    expect(doc.auth.self_service_reset).toBe(true)
    const up = await call('/auth/sign-up/email', { body: { name: 'Ann', email: EMAIL, password: OLD } })
    expect(up.status, await up.clone().text()).toBe(200)
    const oldCookie = up.headers.get('set-cookie')!.split(';')[0]!

    const res = await call('/auth/request-password-reset', { body: { email: EMAIL } })
    expect(res.status, await res.clone().text()).toBe(200)
    const sent = await until(emails, (m) => m.length > 0)
    expect(sent).toHaveLength(1)
    const m = sent[0]!
    expect(m.to).toBe(EMAIL)
    expect(m.from).toEqual({ email: 'noreply@vibase.test', name: 'Vibase' })
    expect(m.subject).toBe(`Reset your Vibase password at ${new URL(BASE).host}`)
    const link = /https?:\/\/\S+#token=\S+/.exec(m.text)![0]!
    expect(link).toMatch(new RegExp(`^${BASE}/reset-password#token=`))
    expect(m.html).toContain(link)
    const token = new URL(link).hash.replace('#token=', '')

    // an unknown address: the same answer, nothing sent
    const unknown = await call('/auth/request-password-reset', { body: { email: 'nobody@auth.test' } })
    expect([unknown.status, await unknown.json()]).toEqual([res.status, await res.json()])
    await new Promise((r) => setTimeout(r, 300))
    expect(await emails()).toHaveLength(1)

    // the recorded link completes a reset: the new password signs in, the old one fails, the earlier session ends
    const done = await call('/auth/reset-password', { body: { token, newPassword: NEW } })
    expect(done.status, await done.clone().text()).toBe(200)
    expect((await call('/auth/sign-in/email', { body: { email: EMAIL, password: NEW } })).status).toBe(200)
    expect((await call('/auth/sign-in/email', { body: { email: EMAIL, password: OLD } })).status).toBe(401)
    expect(await (await call('/auth/get-session', { cookie: oldCookie })).json()).toBeNull()

    // the Worker's own log never holds the address or the token
    for (const line of w.logs) {
      expect(line).not.toContain(EMAIL)
      expect(line).not.toContain(token)
    }
  })
})
