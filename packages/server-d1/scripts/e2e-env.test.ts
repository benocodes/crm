import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadDevClerkEnv } from './e2e-env.js'

// [[UI30]] E2E harness: the Playwright config reads Clerk keys from the gitignored `.env.dev` only, and only development keys.
// Built at run time so a secret scanner does not mistake the fixtures for real keys.
const sk = (kind: string) => ['sk', kind, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'].join('_')
const pk = (kind: string, host = 'acme-test-12.clerk.accounts.dev') => ['pk', kind, btoa(`${host}$`)].join('_')

const dir = mkdtempSync(join(tmpdir(), 'e2e-env-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, text: string) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

describe('loadDevClerkEnv', () => {
  it('reads a development pair and derives the issuer from the publishable key', () => {
    const r = loadDevClerkEnv(file('.env.dev', `CLERK_SECRET_KEY=${sk('test')}\nCLERK_PUBLISHABLE_KEY=${pk('test')}\n`))
    expect(r).toEqual({ secretKey: sk('test'), publishableKey: pk('test'), issuer: 'https://acme-test-12.clerk.accounts.dev' })
  })
  it('accepts VITE_CLERK_PUBLISHABLE_KEY', () => {
    expect(loadDevClerkEnv(file('.env.dev', `CLERK_SECRET_KEY=${sk('test')}\nVITE_CLERK_PUBLISHABLE_KEY=${pk('test')}\n`)).publishableKey).toBe(pk('test'))
  })
  it.each([
    ['a live secret key', `CLERK_SECRET_KEY=${sk('live')}\nCLERK_PUBLISHABLE_KEY=${pk('test')}\n`],
    ['a live publishable key', `CLERK_SECRET_KEY=${sk('test')}\nCLERK_PUBLISHABLE_KEY=${pk('live')}\n`],
    ['no secret key', `CLERK_PUBLISHABLE_KEY=${pk('test')}\n`],
    ['no publishable key', `CLERK_SECRET_KEY=${sk('test')}\n`],
  ])('%s is refused, naming the problem and never a value', (_n, text) => {
    const p = file('.env.dev', text)
    let msg = ''
    try {
      loadDevClerkEnv(p)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).not.toBe('')
    expect(msg).not.toContain(sk('live'))
    expect(msg).not.toContain(sk('test'))
  })
  it.each(['.env', '.env.hq', '.env.hq-staging', '.env.local', '.env.production'])('refuses the file name %s: only .env.dev is read', (name) => {
    const p = file(name, `CLERK_SECRET_KEY=${sk('test')}\nCLERK_PUBLISHABLE_KEY=${pk('test')}\n`)
    expect(() => loadDevClerkEnv(p)).toThrow(/\.env\.dev/)
  })
})
