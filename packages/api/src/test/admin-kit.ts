// Test-only. The per-file setup of the administration suites: a real authenticator over the fake Clerk
// issuer, one `call` per subject or API key, and event reads in write order.
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { randomBytes } from 'node:crypto'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { createApp } from '../rest/app.js'
import {
  clerkMembership,
  clerkOrganization,
  clerkUser,
  mintClerkToken,
  orgClaim,
  signClerkWebhook,
  testClerkAdapter,
  type ClerkUserJson,
} from './clerk.js'
import { seedApiKey } from './keys.js'

export type CallInit = {
  method?: string
  /** A vault organisation id: the kit mints the organisation claim for it, with the caller's live role in the copy. */
  org?: string
  body?: unknown
  /** An explicit organisation claim (Clerk ids), overriding `org`. */
  claim?: { id: string; rol: string }
  /** Sent as `x-organization-id`. */
  header?: string
}
export interface AdminKit {
  db: Kysely<Database>
  owner: Kysely<Database>
  profiles: Map<string, ClerkUserJson>
  /** The fake Clerk: its adapter, fetch spy and organisation and membership maps. */
  clerk: Awaited<ReturnType<typeof testClerkAdapter>>
  app: ReturnType<typeof createApp>
  /** One request as the Clerk subject `sub`. */
  call(path: string, sub: string, init?: CallInit): Promise<Response>
  /** One request with an API key. */
  keyCall(path: string, key: string, init?: CallInit): Promise<Response>
  /** Events of the test, in write order (never by id: api-routes). */
  events(): Promise<Array<{ id: string; type: string; actor_id: string; organization_id: string; resource_id: string; before: any; after: any }>>
  /** A Clerk profile for `sub`; returns the email. */
  profile(sub: string, opts?: { verified?: boolean; email?: string }): string
  /** A signed delivery to `/webhooks/clerk`. `raw` replaces the body; `headers` are merged over the signed ones. */
  webhook(
    payload: unknown,
    opts?: { secret?: string; id?: string; timestamp?: number; headers?: Record<string, string | undefined> },
  ): Promise<Response>
  /** The system principal's id. */
  systemId(): Promise<string>
  /**
   * A linked organisation with an owner (`o`) and a member (`m`), both verified, mirrored in the fake Clerk
   * (organisation and memberships), so a reconcile finds nothing to change.
   */
  seedOrg(
    name?: string,
    subs?: { owner?: string; member?: string },
  ): Promise<{ organizationId: string; externalId: string; ownerId: string; memberId: string }>
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
    k.clerk = kit
    k.app = createApp({ db: () => k.db, authAdapter: kit.adapter })
    const request = (path: string, token: string, init: CallInit = {}) =>
      k.app.request(path, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, ...(init.header !== undefined ? { 'x-organization-id': init.header } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    // P7: the organisation claim comes from the copy: the organisation's external id and the caller's live role.
    const claimFor = async (sub: string, org: string): Promise<{ id: string; rol: string }> => {
      const row = await k.owner
        .selectFrom('organizations')
        .select(['auth_org_id'])
        .where('id', '=', org)
        .executeTakeFirst()
      if (!row?.auth_org_id) throw new Error(`organisation ${org} is not linked; seed it with seedOrg or pass claim`)
      const m = await k.owner
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select('memberships.role')
        .where('memberships.organization_id', '=', org)
        .where('users.auth_subject', '=', sub)
        .where('memberships.deleted_at', 'is', null)
        .executeTakeFirst()
      return { id: row.auth_org_id, rol: m?.role === 'owner' ? 'admin' : 'member' }
    }
    k.call = async (path, sub, init = {}) => {
      const claim = init.claim ?? (init.org ? await claimFor(sub, init.org) : undefined)
      const token = await mintClerkToken(kit.issuer, { sub, ...(claim ? { extra: orgClaim(claim.id, claim.rol) } : {}) })
      return request(path, token, init)
    }
    k.keyCall = async (path, key, init) => request(path, key, init)
    k.webhook = async (payload, o = {}) => {
      const signed = signClerkWebhook(payload, o)
      const headers: Record<string, string> = { ...signed.headers }
      for (const [name, value] of Object.entries(o.headers ?? {})) {
        if (value === undefined) delete headers[name]
        else headers[name] = value
      }
      return k.app.request('/webhooks/clerk', { method: 'POST', headers, body: signed.body })
    }
    k.systemId = async () =>
      (await k.owner.selectFrom('principals').select('id').where('kind', '=', 'system').executeTakeFirstOrThrow()).id
    k.events = async () =>
      (await k.owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute()) as unknown as Awaited<ReturnType<AdminKit['events']>>
    k.profile = (sub, o = {}) => {
      const email = o.email ?? `${sub}@x.test`
      k.profiles.set(sub, clerkUser({ id: sub, email, verified: o.verified ?? true, first: 'Ada', last: 'L' }))
      return email
    }
    k.seedOrg = async (name, subs = {}) => {
      const externalId = `org_${randomBytes(4).toString('hex')}`
      const orgName = name ?? `Org ${externalId}`
      const org = await seedOrganization(k.db, { name: orgName, authOrgId: externalId })
      const o = subs.owner ?? 'o'
      const m = subs.member ?? 'm'
      const owner = await seedUser(k.db, { organizationId: org.id, role: 'owner', authSubject: o, emailVerified: true, email: `${o}@x.test` })
      const member = await seedUser(k.db, { organizationId: org.id, role: 'member', authSubject: m, emailVerified: true, email: `${m}@x.test` })
      kit.organizations.set(externalId, clerkOrganization({ id: externalId, name: orgName }))
      kit.members.set(externalId, [
        clerkMembership({ organizationId: externalId, userId: o, role: 'org:admin' }),
        clerkMembership({ organizationId: externalId, userId: m, role: 'org:member' }),
      ])
      return { organizationId: org.id, externalId, ownerId: owner.id, memberId: member.id }
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
