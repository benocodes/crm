import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'jsonc-parser'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseBuiltInAuthConfig } from './auth-config.js'
import { composeD1Worker, type D1WorkerEnv } from './compose.js'
import { clerkKit, openWorkerPair, type ClerkKit, type WorkerPair } from './test/kit.js'

// [[UI255]] D6, group 1: `AUTH_TRUSTED_ORIGINS`, one case per entry shape. Accepted values reach `trustedOrigins`; a malformed one fails closed (500 internal, the log names the variable, never the value);
// the variable is read only for `AUTH_PROVIDER=better-auth`. D9: the real `wrangler.jsonc`'s `hq` block names the approvals app and parses under the same rule.
const SECRET = 'a-valid-auth-secret-of-exactly-32!'
const BASE = 'https://vibase.example.workers.dev'
const VALID = { AUTH_PROVIDER: 'better-auth', AUTH_SECRET: SECRET, PUBLIC_BASE_URL: BASE } as const
const parsed = (AUTH_TRUSTED_ORIGINS: string | undefined) =>
  parseBuiltInAuthConfig({ ...VALID, AUTH_TRUSTED_ORIGINS }).trustedOrigins

describe('accepted shapes', () => {
  it.each([
    ['one https origin', 'https://app.example.com', ['https://app.example.com']],
    [
      'several https origins',
      'https://app.example.com,https://pane.example.com',
      ['https://app.example.com', 'https://pane.example.com'],
    ],
    ['http://localhost with a port', 'http://localhost:8788', ['http://localhost:8788']],
    [
      'surrounding spaces',
      '  https://app.example.com , https://b.example.com ',
      ['https://app.example.com', 'https://b.example.com'],
    ],
    [
      'an entry equal to PUBLIC_BASE_URL is dropped, not doubled',
      `${BASE},https://app.example.com`,
      ['https://app.example.com'],
    ],
    ['only PUBLIC_BASE_URL leaves none', BASE, []],
    ['a wildcard entry is kept as written', 'https://*.hq.vibase.ai', ['https://*.hq.vibase.ai']],
    ['a wildcard with a port', 'https://*.hq.vibase.ai:8443', ['https://*.hq.vibase.ai:8443']],
    ['a wildcard on localhost with a port', 'http://*.localhost:5173', ['http://*.localhost:5173']],
    ['a wildcard on a public suffix (no guard)', 'https://*.workers.dev', ['https://*.workers.dev']],
    [
      'a wildcard beside exact entries, repeats collapse, one trailing slash stripped',
      'https://a.example.com,https://*.b.example.com/,https://*.b.example.com',
      ['https://a.example.com', 'https://*.b.example.com'],
    ],
    ['empty is none', '', []],
    ['unset is none', undefined, []],
  ])('%s', (_n, value, want) => {
    expect(parsed(value)).toEqual(want)
  })
})

let w: WorkerPair
let kit: ClerkKit
beforeAll(async () => {
  w = await openWorkerPair()
  kit = await clerkKit()
})
afterAll(() => w.dispose())
let logged: string[] = []
beforeEach(() => {
  logged = []
  for (const level of ['error', 'warn', 'log', 'info'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())
const worker = (extra: Partial<D1WorkerEnv>) =>
  composeD1Worker({ DB: w.d1, CONTROL_DB: w.control, ...extra }, { fetch: kit.fetch })
const get = (wk: ReturnType<typeof worker>, path: string) => wk.fetch(new Request(`https://w.test${path}`))

describe('refused shapes fail closed', () => {
  it.each([
    ['a path', 'https://app.example.com/app'],
    ['a trailing /x', 'https://app.example.com/x'],
    ['http wildcard on a non-localhost host', 'http://*.example.com'],
    ['a bare *', '*'],
    ['a wildcard with no host', 'https://*'],
    ['a wildcard with no scheme', '*.example.com'],
    ['a partial label', 'https://foo*.example.com'],
    ['an inner wildcard', 'https://a.*.example.com'],
    ['two wildcard labels', 'https://*.*.example.com'],
    ['a double star', 'https://**.example.com'],
    ['a question mark', 'https://*.example.com?x'],
    ['a wildcard with a path', 'https://*.example.com/x'],
    ['an IP-literal base', 'https://*.10.0.0.1'],
    ['a chrome-extension wildcard', 'chrome-extension://*'],
    ['http on a non-localhost host', 'http://app.example.com'],
    ['not a URL', 'app.example.com'],
    ['one bad entry among good ones', 'https://app.example.com,https://b.example.com/x'],
  ])('%s: 500 internal, /health 200, the log names AUTH_TRUSTED_ORIGINS and never the value', async (_n, value) => {
    const wk = worker({ ...VALID, AUTH_TRUSTED_ORIGINS: value })
    const res = await get(wk, '/api/v1/contacts')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal error' } })
    expect((await get(wk, '/auth/get-session')).status).toBe(500)
    expect((await get(wk, '/health')).status).toBe(200)
    const text = logged.join('\n')
    expect(text).toContain('AUTH_TRUSTED_ORIGINS')
    for (const part of value.split(',')) expect(text).not.toContain(part.trim())
  })

  it('a well-formed value serves', async () => {
    const wk = worker({ ...VALID, AUTH_TRUSTED_ORIGINS: 'https://app.example.com' })
    expect((await get(wk, '/api/v1/contacts')).status).not.toBe(500)
    expect(logged.filter((l) => /invalid auth configuration/.test(l))).toEqual([])
  })
})

describe('read only for better-auth', () => {
  it('clerk and unset ignore even a malformed value', async () => {
    for (const AUTH_TRUSTED_ORIGINS of ['https://app.example.com/x', '*', 'nope']) {
      const clerk = worker({ ...kit.env, CLERK_WEBHOOK_SECRET: undefined, AUTH_TRUSTED_ORIGINS })
      expect((await get(clerk, '/api/v1/contacts')).status).not.toBe(500)
      const unset = worker({ AUTH_PROVIDER: '', AUTH_TRUSTED_ORIGINS })
      expect((await get(unset, '/api/v1/contacts')).status).not.toBe(500)
    }
    expect(logged.filter((l) => /invalid auth configuration/.test(l))).toEqual([])
  })
})

describe('D9: the real wrangler.jsonc', () => {
  const config = parse(readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8')) as {
    env: Record<string, { vars: Record<string, string> }>
  }
  it('the hq block names the approvals app and the value parses under D6', () => {
    const v = config.env.hq!.vars.AUTH_TRUSTED_ORIGINS
    expect(v).toBe('https://app.hq.vibase.ai')
    expect(
      parseBuiltInAuthConfig({ ...VALID, PUBLIC_BASE_URL: 'https://api.hq.vibase.ai', AUTH_TRUSTED_ORIGINS: v })
        .trustedOrigins,
    ).toEqual(['https://app.hq.vibase.ai'])
  })
})
