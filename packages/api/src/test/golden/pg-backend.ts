// Test-only. The Postgres golden backend: the real app over a `vault_app` pool, fixed principals seeded
// through the service role, the clock and ids injected through the app options.
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { createApp, type AppOptions } from '../../rest/app.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../user-auth.js'
import type { EventView, GoldenBackend } from './runner.js'
import { IDS, type GoldenActor } from './scenarios.js'

export const GOLDEN_ID_PREFIX = '0190b2c4-0000-7000-8000-0000010000'
export const goldenId = (n: number): string => GOLDEN_ID_PREFIX + String(n).padStart(2, '0')

export interface PgGoldenBackend extends GoldenBackend {
  close(): Promise<void>
}

/**
 * `extra(state)` adds app options that take the injected clock and ids (absent for the pre-migration
 * service, which has neither). `freezeUpdatedAt` disables the `updated_at` trigger so the stored clock is
 * the injected one: a named difference, applied by the generator only (production keeps the trigger).
 */
export function pgGoldenBackend(opts: {
  extra?: (state: { db: Kysely<Database>; clock: () => Date; newId: () => string }) => Partial<AppOptions>
  freezeUpdatedAt?: boolean
  pauseMs?: number
} = {}): PgGoldenBackend {
  const db = createTestDb()
  const owner = createOwnerTestDb()
  let now = new Date(0)
  let counter = 0
  const extra = opts.extra?.({ db, clock: () => now, newId: () => goldenId(++counter) }) ?? {}
  const app = createApp({ db: () => db, userAuthenticator: fakeUserAuthenticator(), ...extra })
  const scopes = ['tasks:read', 'tasks:write']
  return {
    async reset() {
      await truncateAll(owner)
      counter = 0
      await sql`ALTER TABLE tasks ${sql.raw(opts.freezeUpdatedAt ? 'DISABLE' : 'ENABLE')} TRIGGER set_updated_at`.execute(owner)
      await withServiceRole(db, async (trx) => {
        for (const id of [IDS.org, IDS.foreignOrg]) {
          await trx.insertInto('organizations').values({ id, name: `Golden ${id.slice(-4)}` }).execute()
        }
        const people: Array<[string, 'user' | 'agent', string]> = [
          [IDS.user, 'user', IDS.org],
          [IDS.user2, 'user', IDS.org],
          [IDS.agent, 'agent', IDS.org],
          [IDS.foreignUser, 'user', IDS.foreignOrg],
        ]
        for (const [id, kind, org] of people) {
          await trx.insertInto('principals').values({ id, kind }).execute()
          if (kind === 'user') {
            await trx.insertInto('users').values({ id, email: `${id.slice(-4)}@golden.test` }).execute()
            await trx.insertInto('memberships').values({ organization_id: org, user_id: id, role: 'member', created_by: id }).execute()
          } else {
            await trx.insertInto('agents').values({ id, organization_id: org, name: 'golden-agent', scopes, created_by: IDS.user }).execute()
          }
        }
      })
    },
    async send(actor: GoldenActor, method, path, body, clock) {
      now = new Date(clock)
      if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs))
      const token = mintTestUserToken({ userId: actor === 'agent' ? IDS.agent : IDS.user, organizationId: IDS.org, scopes, kind: actor })
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text === '' ? null : JSON.parse(text) }
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
