import { createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RemoteRefusal } from '../remote.js'
import { decodePublishableKey, loadClerkKeys, pemFromJwk } from './clerk-keys.js'
import { parseSetupArgs } from './args.js'
import { ISSUER, PK_TEST, SK_LIVE_SENTINEL, SK_TEST, jwkFor } from './test/clerk-world.js'
import { makeWorld } from './test/world.js'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const PK_LIVE = `pk_live_${b64('clerk.acme.example$')}`
const opts = (extra: string[] = []) => parseSetupArgs(['--env', 'acme', '--api-host', 'api.acme.vibase.ai', '--owner-email', 'o@example.com', ...extra])
const load = (extra: string[], text: string | null, status?: 'root-env' | 'not-ignored') => {
  const w = makeWorld({ d1: undefined as never, clerkEnvText: text, clerkFileStatus: status })
  return loadClerkKeys(opts(extra), w.deps)
}
const refusal = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(RemoteRefusal)
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

describe('decodePublishableKey (D14)', () => {
  it('decodes the Frontend API host into the issuer', () => {
    expect(decodePublishableKey(PK_TEST)).toBe(ISSUER)
    expect(decodePublishableKey(PK_LIVE)).toBe('https://clerk.acme.example')
  })
  it.each(['pk_test_', 'pk_test_!!!', `pk_test_${b64('no-dollar-sign.example')}`, `pk_test_${b64('not a host$')}`, 'pk_other_abc'])('%s is malformed', (k) => {
    expect(() => decodePublishableKey(k)).toThrow(RemoteRefusal)
  })
})

describe('pemFromJwk (D14)', () => {
  it('is the instance RSA public key in SPKI PEM, which node reads back as the same key', () => {
    const pem = pemFromJwk(jwkFor('k1'))
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/)
    expect(createPublicKey(pem).export({ format: 'jwk' })).toMatchObject({ kty: 'RSA', n: jwkFor('k1').n, e: jwkFor('k1').e })
  })
})

describe('loadClerkKeys (D34, D35, D36)', () => {
  const file = `CLERK_SECRET_KEY=${SK_TEST}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n`
  it('reads the file on its own: development kind, issuer from the publishable key', () => {
    expect(load([], file)).toMatchObject({ secretKey: SK_TEST, publishableKey: PK_TEST, kind: 'development', issuer: ISSUER })
  })
  it('CLERK_PUBLISHABLE_KEY wins over VITE_CLERK_PUBLISHABLE_KEY', () => {
    expect(load([], `${file}CLERK_PUBLISHABLE_KEY=${PK_TEST}\n`).publishableKey).toBe(PK_TEST)
  })
  it('--clerk-publishable-key equal to the file is accepted, different is refused, and it fills a file that has none', () => {
    expect(load(['--clerk-publishable-key', PK_TEST], file).publishableKey).toBe(PK_TEST)
    expect(refusal(() => load(['--clerk-publishable-key', `pk_test_${b64('other.clerk.accounts.dev$')}`], file))).toMatch(/differs/)
    expect(load(['--clerk-publishable-key', PK_TEST], `CLERK_SECRET_KEY=${SK_TEST}\n`).issuer).toBe(ISSUER)
  })
  it.each([
    ['the root .env', file, 'root-env' as const, /root \.env/],
    ['a file git does not ignore', file, 'not-ignored' as const, /ignore/],
    ['a missing file', null, undefined, /not found|missing|no such/i],
    ['a file without CLERK_SECRET_KEY', `VITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n`, undefined, /CLERK_SECRET_KEY/],
    ['a file without a publishable key', `CLERK_SECRET_KEY=${SK_TEST}\n`, undefined, /publishable/],
  ])('refuses %s', (_n, text, status, re) => {
    expect(refusal(() => load([], text, status))).toMatch(re)
  })
  it('refuses a secret key of neither shape, and a publishable key of neither shape', () => {
    expect(refusal(() => load([], `CLERK_SECRET_KEY=not-a-key\nVITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n`))).toMatch(/sk_test_|sk_live_/)
    expect(refusal(() => load([], `CLERK_SECRET_KEY=${SK_TEST}\nVITE_CLERK_PUBLISHABLE_KEY=nope\n`))).toMatch(/pk_test_|pk_live_/)
  })
  it('refuses sk_live_ without --clerk-production, and --clerk-production with sk_test_ (D36)', () => {
    const live = `CLERK_SECRET_KEY=${SK_LIVE_SENTINEL}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_LIVE}\n`
    expect(refusal(() => load([], live))).toMatch(/--clerk-production/)
    expect(load(['--clerk-production'], live).kind).toBe('production')
    expect(refusal(() => load(['--clerk-production'], file))).toMatch(/development/)
  })
  it('refuses a secret and publishable key of different kinds (D35)', () => {
    expect(refusal(() => load(['--clerk-production'], `CLERK_SECRET_KEY=${SK_LIVE_SENTINEL}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n`))).toMatch(/different|mismatch/i)
    expect(refusal(() => load([], `CLERK_SECRET_KEY=${SK_TEST}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_LIVE}\n`))).toMatch(/different|mismatch/i)
  })
  it('never echoes a key value in a refusal', () => {
    const msgs = [refusal(() => load([], `CLERK_SECRET_KEY=${SK_LIVE_SENTINEL}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_LIVE}\n`)), refusal(() => load([], `CLERK_SECRET_KEY=${SK_TEST}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_LIVE}\n`))]
    for (const m of msgs) expect(m).not.toMatch(/SENTINEL|CANARY|sk_(test|live)_\w{6}/)
  })
})
