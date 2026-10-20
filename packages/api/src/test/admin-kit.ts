// Test-only. The per-file setup of the administration suites: a real authenticator over the fake Clerk
// issuer, one `call` per subject or API key, and event reads in write order.
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { createApp } from '../rest/app.js'
import { clerkUser, mintClerkToken, testClerkAdapter, type ClerkUserJson } from './clerk.js'
import { seedApiKey } from './keys.js'

export type CallInit = { method?: string; org?: string; body?: unknown }
export interface AdminKit {
  db: Kysely<Database>
  owner: Kysely<Database>
  profiles: Map<string, ClerkUserJson>
  app: ReturnType<typeof createApp>
  /** One request as the Clerk subject `sub`. */
  call(path: string, sub: string, init?: CallInit): Promise<Response>
  /** One request with an API key. */
  keyCall(path: string, key: string, init?: CallInit): Promise<Response>
  /** Events of the test, in write order (never by id: api-routes). */
  events(): Promise<Array<{ id: string; type: string; actor_id: string; organization_id: string; resource_id: string; before: any; after: any }>>
  /** A Clerk profile for `sub`; returns the email. */
  profile(sub: string, opts?: { verified?: boolean; email?: string }): string
  /** An organisation with an owner (`o`) and a member (`m`), both verified, and (optionally) an agent. */
  seedOrg(name?: string, subs?: { owner?: string; member?: string }): Promise<{ organizationId: string; ownerId: string; memberId: string }>
  /** An agent with a key; scopes are those of the seeded agent row. */
  seedKeyedAgent(organizationId: string, createdBy: string, scopes: string[]): Promise<{ agentId: string; key: string }>
  userId(sub: string): Promise<string>
}

export function useAdminKit(opts: { max?: number } = {}): AdminKit {
  const k = {} as AdminKit
  beforeAll(() => {
    k.db = createTestDb({ max: opts.max ?? 4 })
    k.owner = createOwnerTestDb()
  })
  afterAll(async () => {
    await k.db.destroy()
    await k.owner.destroy()
  })
  beforeEach(async () => {
    await truncateAll(k.owner)
    k.profiles = new Map()
    const kit = await testClerkAdapter({ profiles: k.profiles })
    k.app = createApp({ db: () => k.db, authAdapter: kit.adapter })
    const request = (path: string, token: string, init: CallInit = {}) =>
      k.app.request(path, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, ...(init.org ? { 'x-organization-id': init.org } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    k.call = async (path, sub, init) => request(path, await mintClerkToken(kit.issuer, { sub }), init)
    k.keyCall = async (path, key, init) => request(path, key, init)
    k.events = async () =>
      (await k.owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute()) as unknown as Awaited<ReturnType<AdminKit['events']>>
    k.profile = (sub, o = {}) => {
      const email = o.email ?? `${sub}@x.test`
      k.profiles.set(sub, clerkUser({ id: sub, email, verified: o.verified ?? true, first: 'Ada', last: 'L' }))
      return email
    }
    k.seedOrg = async (name, subs = {}) => {
      const org = await seedOrganization(k.db, { name })
      const o = subs.owner ?? 'o'
      const m = subs.member ?? 'm'
      const owner = await seedUser(k.db, { organizationId: org.id, role: 'owner', authSubject: o, emailVerified: true, email: `${o}@x.test` })
      const member = await seedUser(k.db, { organizationId: org.id, role: 'member', authSubject: m, emailVerified: true, email: `${m}@x.test` })
      return { organizationId: org.id, ownerId: owner.id, memberId: member.id }
    }
    k.seedKeyedAgent = async (organizationId, createdBy, scopes) => {
      const agent = await seedAgent(k.db, { organizationId, createdBy, scopes })
      const key = await seedApiKey(k.db, { organizationId, agentId: agent.id, createdBy })
      return { agentId: agent.id, key: key.key }
    }
    k.userId = async (sub) => (await k.owner.selectFrom('users').select('id').where('auth_subject', '=', sub).executeTakeFirstOrThrow()).id
  })
  return k
}
