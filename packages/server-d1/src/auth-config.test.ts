import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { clerkKit, openWorkerD1, type ClerkKit, type WorkerD1 } from './test/kit.js'

// [[CORE243]] D6, P2: the configuration of `AUTH_PROVIDER=better-auth`. A missing or malformed value fails closed (`500 internal` on every non-health request,
// `/health` still 200), the log names the variable and never its value; `clerk` and unset never read the two variables for auth.
const SECRET = 'a-valid-auth-secret-of-exactly-32!' // 34 characters
const VALID = { AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: 'https://vibase.example.workers.dev' } as const

let w: WorkerD1
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerD1()
  kit = await clerkKit()
})
afterAll(() => w.dispose())

let logged: string[] = []
beforeEach(() => {
  logged = []
  for (const level of ['error', 'warn', 'log', 'info'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())

const worker = (extra: Partial<D1WorkerEnv>) => composeD1Worker({ DB: w.d1, ...extra }, { fetch: kit.fetch })
const get = (wk: ReturnType<typeof worker>, path: string) => wk.fetch(new Request(`https://w.test${path}`))

describe('AUTH_SECRET and PUBLIC_BASE_URL for better-auth', () => {
  it.each([
    ['AUTH_SECRET missing', { AUTH_SECRET: undefined }, 'AUTH_SECRET'],
    ['AUTH_SECRET empty', { AUTH_SECRET: '' }, 'AUTH_SECRET'],
    ['AUTH_SECRET short (31 characters)', { AUTH_SECRET: 'abcdefghij0123456789abcdefghijk' }, 'AUTH_SECRET'],
    ['AUTH_SECRET padded with spaces', { AUTH_SECRET: `  ${SECRET}  ` }, 'AUTH_SECRET'],
    ['AUTH_SECRET with a trailing newline', { AUTH_SECRET: `${SECRET}\n` }, 'AUTH_SECRET'],
    ['PUBLIC_BASE_URL missing', { PUBLIC_BASE_URL: undefined }, 'PUBLIC_BASE_URL'],
    ['PUBLIC_BASE_URL with a path', { PUBLIC_BASE_URL: 'https://vibase.example.workers.dev/app' }, 'PUBLIC_BASE_URL'],
    ['PUBLIC_BASE_URL http on a non-localhost host', { PUBLIC_BASE_URL: 'http://vibase.example.workers.dev' }, 'PUBLIC_BASE_URL'],
    ['PUBLIC_BASE_URL not a URL', { PUBLIC_BASE_URL: 'vibase.example.workers.dev' }, 'PUBLIC_BASE_URL'],
  ])('%s: a non-health request is 500 internal, /health is 200, and the log names the variable but never a value', async (_n, change, name) => {
    const env = { ...VALID, ...change } as Partial<D1WorkerEnv>
    const wk = worker(env)
    const res = await get(wk, '/api/v1/contacts')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } })
    expect((await get(wk, '/auth/get-session')).status).toBe(500)
    expect((await get(wk, '/health')).status).toBe(200)
    const text = logged.join('\n')
    expect(text).toContain(name)
    for (const value of [env.AUTH_SECRET, env.PUBLIC_BASE_URL]) if (value && value.trim().length > 3) expect(text, `value ${value.trim().slice(0, 6)}...`).not.toContain(value.trim())
    expect(text).not.toContain('abcdefghij0123456789')
  })

  it.each([
    ['the minimum secret (32 characters) and an https origin', { AUTH_SECRET: 'abcdefghij0123456789abcdefghijkl', PUBLIC_BASE_URL: 'https://vibase.example' }],
    ['a workers.dev origin', {}],
    ['http://localhost for local development', { PUBLIC_BASE_URL: 'http://localhost:8787' }],
  ])('%s serves: an API route is the normal answer, not a configuration error', async (_n, change) => {
    const wk = worker({ ...VALID, ...change } as Partial<D1WorkerEnv>)
    const res = await get(wk, '/api/v1/contacts')
    expect(res.status).not.toBe(500)
    expect((await get(wk, '/auth/get-session')).status).not.toBe(500)
    expect(logged.filter((l) => /invalid auth configuration/.test(l))).toEqual([])
  })

  it('clerk and unset never read AUTH_SECRET or PUBLIC_BASE_URL for auth: no value, a short or a padded one all serve as today', async () => {
    for (const extra of [{}, { AUTH_SECRET: 'short' }, { AUTH_SECRET: `  ${SECRET}  `, PUBLIC_BASE_URL: 'not a url' }]) {
      const clerk = worker({ ...kit.env, CLERK_WEBHOOK_SECRET: undefined, ...extra } as Partial<D1WorkerEnv>)
      expect((await get(clerk, '/api/v1/contacts')).status).not.toBe(500)
      const unset = worker({ AUTH_PROVIDER: '', ...extra } as Partial<D1WorkerEnv>)
      expect((await get(unset, '/api/v1/contacts')).status).not.toBe(500)
    }
    expect(logged.filter((l) => /invalid auth configuration/.test(l))).toEqual([])
  })

  it('an unknown provider is still a configuration error, and better-auth is no longer one', async () => {
    expect((await get(worker({ AUTH_PROVIDER: 'nope' }), '/api/v1/contacts')).status).toBe(500)
    expect((await get(worker({ ...VALID }), '/api/v1/contacts')).status).not.toBe(500)
  })
})
