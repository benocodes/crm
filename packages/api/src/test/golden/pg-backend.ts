// Test-only. The Postgres golden backend: the real app over a `vault_app` pool, fixed principals seeded
// through the service role, the clock and ids injected through the app options.
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { createApp, type AppOptions } from '../../rest/app.js'
import { hashApiKey } from '../../auth/api-keys.js'
import { goldenAuthenticator, goldenClerk, goldenSend, loadGoldenClerk, mountGoldenWebhook, type GoldenClerkKit } from './kit.js'
import type { EventView, GoldenBackend } from './runner.js'
import { GOLDEN_AGENT_KEY, GOLDEN_EXPIRED_KEY, GOLDEN_FOREIGN_LINK, GOLDEN_ORG_LINK, GOLDEN_SUBJECTS, IDS, type GoldenActor } from './scenarios.js'

export const GOLDEN_ID_PREFIX = '0190b2c4-0000-7000-8000-00000100'
/** The n-th id a scenario mints: a four-digit counter, refused above 9999 (a longer one would not be a UUID). */
export const goldenId = (n: number): string => {
  if (n > 9999) throw new Error(`golden id counter ${n} exceeds 9999`)
  return GOLDEN_ID_PREFIX + String(n).padStart(4, '0')
}
export const GOLDEN_SCOPES = ['tasks:read', 'tasks:write', 'companies:read', 'companies:write', 'contacts:read', 'contacts:write', 'agents:read', 'agents:write', 'members:read']
/** Every seeded row is stamped with this instant on both engines (CORE40 P12): nothing a read returns comes from a database default. */
export const GOLDEN_SEED_AT = '2026-10-22T08:00:00.000Z'
/** The deterministic random source of golden runs (CORE40 P12): the n-th call yields bytes all equal to n. */
export const goldenRandomBytes = (counter: { n: number }) => (size: number): Uint8Array => new Uint8Array(size).fill(++counter.n)

export interface PgGoldenBackend extends GoldenBackend {
  close(): Promise<void>
}

/** `extra(state)` adds app options that take the injected clock and ids. The application owns every timestamp (CORE36 D2): nothing is frozen or disabled. */
export function pgGoldenBackend(opts: {
  extra?: (state: { db: Kysely<Database>; clock: () => Date; newId: () => string; randomBytes: (n: number) => Uint8Array }) => Partial<AppOptions>
  pauseMs?: number
} = {}): PgGoldenBackend {
  const db = createTestDb()
  const owner = createOwnerTestDb()
  let now = new Date(0)
  let counter = 0
  const random = { n: 0 }
  const clock = () => now
  const newId = () => goldenId(++counter)
  const extra = opts.extra?.({ db, clock, newId, randomBytes: goldenRandomBytes(random) }) ?? {}
  const scopes = GOLDEN_SCOPES
  // The fake Clerk and the app over it are made on the first reset: the issuer's key pair is async.
  let clerk: GoldenClerkKit | undefined
  let app: ReturnType<typeof createApp> | undefined
  return {
    async reset() {
      if (!clerk) {
        clerk = await goldenClerk(clock)
        app = createApp({ db: () => db, userAuthenticator: goldenAuthenticator(clerk), ...extra })
        mountGoldenWebhook(app, clerk, { clock, newId })
      }
      await truncateAll(owner)
      counter = 0
      random.n = 0
      await withServiceRole(db, async (trx) => {
        for (const [id, link] of [[IDS.org, GOLDEN_ORG_LINK], [IDS.foreignOrg, GOLDEN_FOREIGN_LINK]] as const) {
          await trx.insertInto('organizations').values({ id, name: `Golden ${id.slice(-4)}`, auth_provider: 'clerk', auth_org_id: link, created_at: GOLDEN_SEED_AT, updated_at: GOLDEN_SEED_AT }).execute()
        }
        const at = { created_at: GOLDEN_SEED_AT, updated_at: GOLDEN_SEED_AT }
        // [id, kind, organisation, membership id, role]
        const people: Array<[string, 'user' | 'agent', string, string | null, 'owner' | 'member']> = [
          [IDS.user, 'user', IDS.org, IDS.membership, 'owner'],
          [IDS.user2, 'user', IDS.org, IDS.membership2, 'member'],
          [IDS.agent, 'agent', IDS.org, null, 'member'],
          [IDS.foreignUser, 'user', IDS.foreignOrg, null, 'member'],
        ]
        for (const [id, kind, org, membership, role] of people) {
          await trx.insertInto('principals').values({ id, kind, created_at: GOLDEN_SEED_AT }).execute()
          if (kind === 'user') {
            const subject = id === IDS.user ? GOLDEN_SUBJECTS.user : id === IDS.user2 ? GOLDEN_SUBJECTS.user2 : undefined
            await trx.insertInto('users').values({ id, email: `${id.slice(-4)}@golden.test`, ...(subject ? { auth_provider: 'clerk', auth_subject: subject } : {}), ...at }).execute()
            await trx.insertInto('memberships').values({ ...(membership ? { id: membership } : {}), organization_id: org, user_id: id, role, created_by: id, ...at }).execute()
          } else {
            await trx.insertInto('agents').values({ id, organization_id: org, name: 'golden-agent', scopes, created_by: IDS.user, ...at }).execute()
          }
        }
      })
    },
    async load(scenario) {
      loadGoldenClerk(clerk!, scenario.clerk)
      if (!scenario.keys) return
      // The agent's two fixed keys (CORE41 P15): one valid, one that expired half an hour after the seed instant.
      await withServiceRole(db, async (trx) => {
        for (const [id, key, expires] of [[IDS.agentKey, GOLDEN_AGENT_KEY, null], [IDS.expiredKey, GOLDEN_EXPIRED_KEY, '2026-10-22T08:30:00.000Z']] as const) {
          await trx
            .insertInto('api_keys')
            .values({ id, organization_id: IDS.org, agent_id: IDS.agent, key_hash: await hashApiKey(key), prefix: 'vk_golden-ag', expires_at: expires, created_by: IDS.user, created_at: GOLDEN_SEED_AT, updated_at: GOLDEN_SEED_AT })
            .execute()
        }
      })
    },
    async send(actor: GoldenActor, method, path, body, at) {
      now = new Date(at)
      if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs))
      return goldenSend({ app: app!, clerk: clerk!, scopes }, actor, method, path, body, now)
    },
    async events() {
      const rows = await owner.selectFrom('events').selectAll().orderBy(sql`ctid`).execute()
      return rows.map(
        (r): EventView => ({
          type: r.type,
          resource_type: r.resource_type,
          resource_id: r.resource_id,
          actor_id: r.actor_id,
          organization_id: r.organization_id,
          created_at: (r.created_at as unknown as Date).toISOString(),
          before: r.before,
          after: r.after,
        }),
      )
    },
    async close() {
      await db.destroy()
      await owner.destroy()
    },
  }
}
