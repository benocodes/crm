// Test-only: never import from non-test code. A local RS256 issuer and a fake Clerk Backend API, so
// no test or smoke needs a Clerk account ([[CORE3]]).
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from 'jose'
import { createClerkAdapter } from '../auth/clerk.js'
import type { AuthAdapter } from '../auth/adapter.js'
import fixture from './fixtures/clerk-user.json' with { type: 'json' }

export type ClerkUserJson = typeof fixture

export const ISSUER = 'https://clerk.test.example'
export const PARTY = 'https://pane.test.example'
export const API_URL = 'https://api.clerk.test'
export const SECRET_KEY = 'sk_test_fake'

export type TestIssuer = { privateKey: CryptoKey; publicKey: CryptoKey; pem: string; issuer: string; party: string }

let memo: Promise<TestIssuer> | undefined
/** One key pair per test file (module instance). */
export function testIssuer(): Promise<TestIssuer> {
  memo ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    return { privateKey, publicKey, pem: await exportSPKI(publicKey), issuer: ISSUER, party: PARTY }
  })()
  return memo
}

export type MintOptions = {
  sub?: string
  azp?: unknown
  iss?: string
  exp?: number
  nbf?: number
  alg?: 'RS256' | 'HS256'
  key?: CryptoKey
  omit?: ('sub' | 'exp')[]
  extra?: Record<string, unknown>
  now?: Date
}

export async function mintClerkToken(issuer: TestIssuer, opts: MintOptions = {}): Promise<string> {
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const payload: Record<string, unknown> = { sid: 'sess_test', v: 2, ...opts.extra }
  if ('azp' in opts) {
    if (opts.azp !== undefined) payload.azp = opts.azp
  } else payload.azp = issuer.party
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256' })
    .setIssuedAt(now)
    .setNotBefore(opts.nbf ?? now)
    .setIssuer(opts.iss ?? issuer.issuer)
  if (!opts.omit?.includes('sub')) jwt.setSubject(opts.sub ?? 'user_1')
  if (!opts.omit?.includes('exp')) jwt.setExpirationTime(opts.exp ?? now + 60)
  const key = opts.alg === 'HS256' ? new TextEncoder().encode('a-symmetric-secret-of-32-bytes!!!') : (opts.key ?? issuer.privateKey)
  const token = await jwt.sign(key)
  return token
}

export function clerkUser(o: { id: string; email?: string | null; verified?: boolean; first?: string | null; last?: string | null }): ClerkUserJson {
  const addresses =
    o.email === null || o.email === undefined
      ? []
      : [
          {
            id: 'idn_primary',
            object: 'email_address',
            email_address: o.email,
            verification: { status: o.verified === false ? 'unverified' : 'verified', strategy: 'from_oauth_google' },
            linked_to: [],
          },
        ]
  return {
    ...fixture,
    id: o.id,
    first_name: o.first === undefined ? 'Ada' : (o.first as string),
    last_name: o.last === undefined ? 'Lovelace' : (o.last as string),
    primary_email_address_id: addresses.length ? 'idn_primary' : (null as unknown as string),
    email_addresses: addresses as ClerkUserJson['email_addresses'],
  }
}

export type FakeFetch = typeof fetch & { calls: { url: string; authorization: string | null }[]; reset(): void }

/** A `fetch` answering `GET /v1/users/<sub>`; 404 for unknown subjects. `gate` holds every answer. */
export function fakeClerkFetch(
  profiles: Map<string, ClerkUserJson>,
  opts: { gate?: Promise<void>; onRequest?: () => void } = {},
): FakeFetch {
  const calls: FakeFetch['calls'] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') })
    opts.onRequest?.()
    if (opts.gate) await opts.gate
    const m = /\/v1\/users\/([^/?]+)$/.exec(new URL(url).pathname + '')
    const sub = m ? decodeURIComponent(m[1]!) : undefined
    const user = sub ? profiles.get(sub) : undefined
    if (!user) return new Response(JSON.stringify({ errors: [{ code: 'resource_not_found' }] }), { status: 404 })
    return new Response(JSON.stringify(user), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as FakeFetch
  f.calls = calls
  f.reset = () => {
    calls.length = 0
  }
  return f
}

export async function testClerkAdapter(
  opts: { profiles?: Map<string, ClerkUserJson>; gate?: Promise<void>; onRequest?: () => void; now?: () => Date; fetch?: typeof fetch } = {},
): Promise<{ adapter: AuthAdapter; issuer: TestIssuer; fetch: FakeFetch; profiles: Map<string, ClerkUserJson> }> {
  const issuer = await testIssuer()
  const profiles = opts.profiles ?? new Map()
  const fetch = fakeClerkFetch(profiles, { gate: opts.gate, onRequest: opts.onRequest })
  const adapter = createClerkAdapter({
    jwtKey: issuer.pem,
    issuer: issuer.issuer,
    authorizedParties: [issuer.party],
    secretKey: SECRET_KEY,
    apiUrl: API_URL,
    fetch: opts.fetch ?? fetch,
    now: opts.now,
  })
  return { adapter, issuer, fetch, profiles }
}
