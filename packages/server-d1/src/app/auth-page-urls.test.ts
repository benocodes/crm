import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invitationUrl, passwordResetUrl } from '@vibase/api'
import { CONSENT_PAGE_PATH, DEVICE_PAGE_PATH, LOGIN_PAGE_PATH } from '@vibase/auth'
import { startGoogleSignIn } from '../ui/auth-api.js'
import { PAGE_TABLE } from './paths.js'

// [[UI510]] D7, P5 (group 4): every URL the vault builds for an auth page names an entry of the page table. `@vibase/api` and `@vibase/auth` cannot import the table, so this test pins their literals to it.
const AUTH_PAGES = PAGE_TABLE.filter((p) => p.bundle === 'ui').map((p) => p.path)
const BASE = 'https://api.vibase.test'
const pathOf = (url: string): string => new URL(url).pathname

describe('the auth pages are in the table', () => {
  it('has the five /app auth pages', () => {
    expect(AUTH_PAGES).toEqual(['/app/sign-in', '/app/invite', '/app/reset-password', '/app/consent', '/app/device'])
  })
})

describe('the URLs other packages build name table entries', () => {
  it("@vibase/api's invitation link", () => {
    expect(AUTH_PAGES).toContain(pathOf(invitationUrl(BASE, 't')))
    expect(invitationUrl(BASE, 't')).toBe(`${BASE}/app/invite#token=t`)
  })
  it("@vibase/api's password reset link", () => {
    expect(AUTH_PAGES).toContain(pathOf(passwordResetUrl(BASE, 't')))
    expect(passwordResetUrl(BASE, 't')).toBe(`${BASE}/app/reset-password#token=t`)
  })
  it("@vibase/auth's loginPage, consentPage and verificationUri paths", () => {
    expect(AUTH_PAGES).toContain(LOGIN_PAGE_PATH)
    expect(AUTH_PAGES).toContain(CONSENT_PAGE_PATH)
    expect(AUTH_PAGES).toContain(DEVICE_PAGE_PATH)
  })
})

describe('the auth pages own links', () => {
  afterEach(() => vi.unstubAllGlobals())
  it("Google sign-in's errorCallbackURL is a table entry", async () => {
    const calls: { errorCallbackURL?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        calls.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ url: 'https://accounts.google.com/x' }), { status: 200 })
      }),
    )
    await startGoogleSignIn()
    expect(AUTH_PAGES).toContain(calls[0]!.errorCallbackURL)
  })
})

describe('no non-test source names an old auth path (P5)', () => {
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) =>
      f === 'node_modules' || f === 'dist' ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
    )
  const isTest = (f: string) => /\.(test|suite)\.tsx?$/.test(f) || f.includes('/test/')
  const code = (text: string) =>
    text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .map((l) => l.replace(/\s\/\/ .*$/, ''))
      .join('\n')
  // A quoted, template or `}`-led old path (`/auth/device` and the other `/auth/...` machine paths are not preceded by a quote).
  const OLD = /(?:['"`}])\/(?:sign-in|invite|reset-password|consent|device)(?![\w-])(?!\/code)/
  const roots = ['server-d1/src', 'server-d1/scripts', 'api/src', 'auth/src', 'approvals-app/src']
  const files = roots
    .flatMap((r) => walk(join(ROOT, r)))
    .filter((f) => /\.tsx?$/.test(f) && !isTest(f))
  it('the scan sees the sources', () => {
    expect(files.map((f) => relative(ROOT, f))).toContain('auth/src/auth.ts')
    expect(files.map((f) => relative(ROOT, f))).toContain('approvals-app/src/better-auth.ts')
  })
  it('the old paths appear in no source line (only /auth/sign-in/... machine paths)', () => {
    const hits = files
      .flatMap((f) =>
        code(readFileSync(f, 'utf8'))
          .split('\n')
          .filter((l) => OLD.test(l) && !/\/auth\/|ctx\.path === '\/sign-in\/social'|call\('POST', '\/auth/.test(l))
          .map((l) => `${relative(ROOT, f)}: ${l.trim()}`),
      )
    expect(hits).toEqual([])
  })
})
