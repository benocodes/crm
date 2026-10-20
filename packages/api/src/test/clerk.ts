// Test-only: never import from non-test code. A local RS256 issuer and a fake Clerk Backend API, so
// no test or smoke needs a Clerk account ([[CORE3]]).
import { createHmac, randomUUID } from 'node:crypto'
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from 'jose'
import { createClerkAdapter } from '../auth/clerk.js'
import type { AuthAdapter } from '../auth/adapter.js'
import fixture from './fixtures/clerk-user.json' with { type: 'json' }
import orgFixture from './fixtures/clerk-organization.json' with { type: 'json' }
import membershipFixture from './fixtures/clerk-organization-membership.json' with { type: 'json' }

export type ClerkUserJson = typeof fixture
export type ClerkOrganizationJson = typeof orgFixture
export type ClerkMembershipJson = typeof membershipFixture

export const ISSUER = 'https://clerk.test.example'
export const PARTY = 'https://pane.test.example'
export const API_URL = 'https://api.clerk.test'
export const SECRET_KEY = 'sk_test_fake'
export const WEBHOOK_SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64')

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
  omit?: ('sub' | 'exp' | 'iat')[]
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
    .setNotBefore(opts.nbf ?? now)
    .setIssuer(opts.iss ?? issuer.issuer)
  if (!opts.omit?.includes('iat')) jwt.setIssuedAt(now)
  if (!opts.omit?.includes('sub')) jwt.setSubject(opts.sub ?? 'user_1')
  if (!opts.omit?.includes('exp')) jwt.setExpirationTime(opts.exp ?? now + 60)
  const key = opts.alg === 'HS256' ? new TextEncoder().encode('a-symmetric-secret-of-32-bytes!!!') : (opts.key ?? issuer.privateKey)
  const token = await jwt.sign(key)
  return token
}

/** The `extra` claims of a Clerk v2 session token with an active organisation. */
export function orgClaim(id: string, rol = 'admin'): Record<string, unknown> {
  return { o: { id, rol, slg: 'test-org' } }
}

export function clerkOrganization(o: { id: string; name: string }): ClerkOrganizationJson {
  return { ...orgFixture, id: o.id, name: o.name }
}

export function clerkMembership(o: { organizationId: string; userId: string; role: string }): ClerkMembershipJson {
  return {
    ...membershipFixture,
    id: `orgmem_${o.organizationId}_${o.userId}`,
    role: o.role,
    organization: { ...membershipFixture.organization, id: o.organizationId },
    public_user_data: { ...membershipFixture.public_user_data, user_id: o.userId },
  }
}

export function clerkWebhook(type: string, data: unknown): { data: unknown; object: 'event'; type: string; timestamp: number } {
  return { data, object: 'event', type, timestamp: Date.now() }
}

/** A Svix-signed delivery of `payload` (an object, or a raw string body). */
export function signClerkWebhook(
  payload: unknown,
  opts: { secret?: string; id?: string; timestamp?: number } = {},
): { headers: Record<string, string>; body: string } {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const id = opts.id ?? `msg_${randomUUID().replace(/-/g, '')}`
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const secret = opts.secret ?? WEBHOOK_SECRET
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  return {
    headers: { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}`, 'content-type': 'application/json' },
    body,
  }
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

export type FakeFetch = typeof fetch & {
  calls: { url: string; authorization: string | null }[]
  /** Force an HTTP status on the organisation or membership endpoints (cleared by `reset`). */
  fail: { organization?: number; members?: number }
  reset(): void
}

const notFound = () => new Response(JSON.stringify({ errors: [{ code: 'resource_not_found' }] }), { status: 404 })
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/**
 * A `fetch` answering `GET /v1/users/<sub>`, `/v1/organizations/<id>` and `/v1/organizations/<id>/memberships`
 * (limit/offset honoured); 404 for anything unknown. `gate` holds every answer.
 */
export function fakeClerkFetch(
  profiles: Map<string, ClerkUserJson>,
  opts: {
    gate?: Promise<void>
    onRequest?: () => void
    organizations?: Map<string, ClerkOrganizationJson>
    members?: Map<string, ClerkMembershipJson[]>
  } = {},
): FakeFetch {
  const calls: FakeFetch['calls'] = []
  const organizations = opts.organizations ?? new Map()
  const members = opts.members ?? new Map()
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') })
    opts.onRequest?.()
    if (opts.gate) await opts.gate
    const parsed = new URL(url)
    const org = /\/v1\/organizations\/([^/?]+)(\/memberships)?$/.exec(parsed.pathname)
    if (org) {
      const id = decodeURIComponent(org[1]!)
      const status = org[2] ? f.fail.members : f.fail.organization
      if (status) return new Response('{}', { status })
      const found = organizations.get(id)
      if (!found) return notFound()
      if (!org[2]) return ok(found)
      const all = members.get(id) ?? []
      const limit = Number(parsed.searchParams.get('limit') ?? 10)
      const offset = Number(parsed.searchParams.get('offset') ?? 0)
      return ok({ data: all.slice(offset, offset + limit), total_count: all.length })
    }
    const m = /\/v1\/users\/([^/?]+)$/.exec(parsed.pathname)
    const sub = m ? decodeURIComponent(m[1]!) : undefined
    const user = sub ? profiles.get(sub) : undefined
    if (!user) return notFound()
    return ok(user)
  }) as FakeFetch
  f.calls = calls
  f.fail = {}
  f.reset = () => {
    calls.length = 0
    f.fail = {}
  }
  return f
}

export async function testClerkAdapter(
  opts: {
    profiles?: Map<string, ClerkUserJson>
    organizations?: Map<string, ClerkOrganizationJson>
    members?: Map<string, ClerkMembershipJson[]>
    gate?: Promise<void>
    onRequest?: () => void
    now?: () => Date
    fetch?: typeof fetch
  } = {},
): Promise<{
  adapter: AuthAdapter
  issuer: TestIssuer
  fetch: FakeFetch
  profiles: Map<string, ClerkUserJson>
  organizations: Map<string, ClerkOrganizationJson>
  members: Map<string, ClerkMembershipJson[]>
}> {
  const issuer = await testIssuer()
  const profiles = opts.profiles ?? new Map()
  const organizations = opts.organizations ?? new Map()
  const members = opts.members ?? new Map()
  const fetch = fakeClerkFetch(profiles, { gate: opts.gate, onRequest: opts.onRequest, organizations, members })
  const adapter = createClerkAdapter({
    jwtKey: issuer.pem,
    issuer: issuer.issuer,
    authorizedParties: [issuer.party],
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiUrl: API_URL,
    fetch: opts.fetch ?? fetch,
    now: opts.now,
  })
  return { adapter, issuer, fetch, profiles, organizations, members }
}
