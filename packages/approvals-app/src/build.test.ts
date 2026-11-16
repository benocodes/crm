// [[UI388]] group 4 (D4): the real build output. The entry chunk (the one index.html loads) carries no Better Auth client code, the provider chunks do; the CSP is unchanged.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../scripts/build.js'

const ENV = { APPROVALS_API_ORIGIN: 'http://localhost:8787' }
// The CSP and headers of today's build for ENV (before UI388), byte for byte.
const HEADERS_BEFORE = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' https://clerk.hq.vibase.ai https://challenges.cloudflare.com https://*.protect.clerk.com; connect-src 'self' http://localhost:8787 https://clerk.hq.vibase.ai https://*.protect.clerk.com:*; img-src 'self' https://img.clerk.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000
/index.html
  Cache-Control: no-store
`
// Present in `better-auth/client`'s code, never in the app's own sources.
const SDK_MARKER = '/get-session'

let out = ''
const text = (p: string) => readFileSync(join(out, p), 'utf8')
const files = (dir: string) => readdirSync(join(out, dir), { recursive: true }).map(String)

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'approvals-build-'))
  await buildApp(ENV, out)
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

describe('build output', () => {
  it('index.html loads an entry that exists, as an ES module', () => {
    const src = /<script type="module" src="\/([^"]+)"/.exec(text('index.html'))?.[1]
    expect(src).toBeTruthy()
    expect(files('.')).toContain(src)
  })

  it('the entry chunk has no Better Auth client code, and a Better Auth chunk has', () => {
    const entry = /<script type="module" src="\/([^"]+)"/.exec(text('index.html'))![1]!
    expect(text(entry)).not.toContain(SDK_MARKER)
    const chunks = files('.').filter((f) => f.endsWith('.js') && f !== entry)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.filter((c) => text(c).includes(SDK_MARKER))).toHaveLength(1)
  })

  it('the Clerk chunk does not carry the Better Auth client', () => {
    const entry = /<script type="module" src="\/([^"]+)"/.exec(text('index.html'))![1]!
    const clerk = files('.').filter((f) => f.endsWith('.js') && f !== entry && text(f).includes('clerk-js'))
    expect(clerk).toHaveLength(1)
    expect(text(clerk[0]!)).not.toContain(SDK_MARKER)
  })

  it('_headers (the CSP) is byte-identical to the build before', () => {
    expect(text('_headers')).toBe(HEADERS_BEFORE)
  })
})

describe('versions', () => {
  it("the app's better-auth is @vibase/auth's", () => {
    const v = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
    const app = v('../package.json')
    const auth = v('../../auth/package.json')
    expect(app.devDependencies['better-auth']).toBe(auth.dependencies['better-auth'])
  })
})
