import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { cloudflareEmailSender, parseEmailConfig } from './email.js'
import { AUTH_BASE, AUTH_SECRET } from './test/auth-kit.js'
import { fakeEmail } from './test/fake-email.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE248]] D1, D2, D8: the adapter's call shape, and the configuration matrix through the composition.
describe('cloudflareEmailSender', () => {
  it('hands the binding exactly { to, from: { email, name: "Vibase" }, subject, text, html }', async () => {
    const fake = fakeEmail()
    await cloudflareEmailSender(fake, 'invites@x.test').send({ to: 'ann@x.test', subject: 'S', text: 'T', html: '<p>H</p>' })
    expect(fake.sent).toEqual([{ to: 'ann@x.test', from: { email: 'invites@x.test', name: 'Vibase' }, subject: 'S', text: 'T', html: '<p>H</p>' }])
  })

  it('rejects when the binding rejects', async () => {
    const fake = fakeEmail()
    fake.failing = true
    await expect(cloudflareEmailSender(fake, 'invites@x.test').send({ to: 'a@x.test', subject: 'S', text: 'T', html: 'H' })).rejects.toThrow()
  })
})

describe('parseEmailConfig', () => {
  it('is off with neither, on with both, and normalises the address', () => {
    expect(parseEmailConfig({})).toBeUndefined()
    expect(parseEmailConfig({ EMAIL: fakeEmail(), AUTH_EMAIL_FROM: '  Invites@X.Test ' })).toEqual({ from: 'invites@x.test' })
  })
  it.each([['no @', 'invites.x.test'], ['two @', 'a@b@x.test'], ['undotted domain', 'a@localhost'], ['blank', '   ']])('a malformed address (%s) throws naming AUTH_EMAIL_FROM and not its value', (_n, from) => {
    try {
      parseEmailConfig({ EMAIL: fakeEmail(), AUTH_EMAIL_FROM: from })
      throw new Error('did not throw')
    } catch (e) {
      expect((e as Error).message).toContain('AUTH_EMAIL_FROM')
      expect((e as Error).message).not.toContain(from.trim() || 'zzz-never')
    }
  })
  it('half a pair throws naming the missing variable', () => {
    expect(() => parseEmailConfig({ EMAIL: fakeEmail() })).toThrow(/AUTH_EMAIL_FROM/)
    expect(() => parseEmailConfig({ AUTH_EMAIL_FROM: 'a@x.test' })).toThrow(/EMAIL/)
  })
})

let w: WorkerPair
beforeAll(async () => {
  w = await openWorkerPair()
})
afterAll(() => w.dispose())
afterEach(() => vi.restoreAllMocks())

const attempt = async (over: Partial<D1WorkerEnv>) => {
  const errors: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')))
  const wk = composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, AUTH_SECRET, PUBLIC_BASE_URL: AUTH_BASE, ...over })
  const health = await wk.fetch(new Request(`${AUTH_BASE}/health`))
  const other = await wk.fetch(new Request(`${AUTH_BASE}/meta/v1/invitations`))
  return { health: health.status, other: other.status, log: errors.join('\n') }
}
const BIND = { EMAIL: fakeEmail() }
const names = (log: string) => /AUTH_EMAIL_FROM|\bEMAIL\b/.test(log)

describe('configuration matrix (D2), provider better-auth', () => {
  const ba = { AUTH_PROVIDER: 'better-auth' }
  it('neither: email off, no configuration error', async () => {
    const r = await attempt(ba)
    expect(r.other).not.toBe(500)
    expect(names(r.log)).toBe(false)
  })
  it('both valid: on, no configuration error', async () => {
    const r = await attempt({ ...ba, ...BIND, AUTH_EMAIL_FROM: 'invites@x.test' })
    expect(r.other).not.toBe(500)
    expect(names(r.log)).toBe(false)
  })
  it('both valid with spaces and upper case: accepted (normalised)', async () => {
    const r = await attempt({ ...ba, ...BIND, AUTH_EMAIL_FROM: '  Invites@X.TEST ' })
    expect(r.other).not.toBe(500)
  })
  it('the binding alone fails closed naming AUTH_EMAIL_FROM; /health still answers', async () => {
    const r = await attempt({ ...ba, ...BIND })
    expect(r.other).toBe(500)
    expect(r.health).toBe(200)
    expect(r.log).toContain('AUTH_EMAIL_FROM')
  })
  it('the address alone fails closed naming EMAIL; /health still answers', async () => {
    const r = await attempt({ ...ba, AUTH_EMAIL_FROM: 'invites@x.test' })
    expect(r.other).toBe(500)
    expect(r.health).toBe(200)
    expect(r.log).toMatch(/\bEMAIL\b/)
  })
  it.each([['no @', 'invites.x.test'], ['two @', 'a@b@x.test'], ['undotted domain', 'invites@localhost']])('a malformed address (%s) fails closed naming the variable, never the value', async (_n, from) => {
    const r = await attempt({ ...ba, ...BIND, AUTH_EMAIL_FROM: from })
    expect(r.other).toBe(500)
    expect(r.health).toBe(200)
    expect(r.log).toContain('AUTH_EMAIL_FROM')
    expect(r.log).not.toContain(from)
  })
})

describe('configuration matrix (D2), other providers ignore both variables', () => {
  it.each([['clerk'], [undefined]])('provider %s with a malformed address and the binding: no email error', async (provider) => {
    const withEmail = await attempt({ ...(provider ? { AUTH_PROVIDER: provider } : {}), ...BIND, AUTH_EMAIL_FROM: 'not an address' })
    const without = await attempt({ ...(provider ? { AUTH_PROVIDER: provider } : {}) })
    expect(names(withEmail.log)).toBe(false)
    expect(withEmail.other).toBe(without.other)
  })
})
