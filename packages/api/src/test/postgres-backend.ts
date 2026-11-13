// Test-only. The Postgres backend of the shared contract suite ([[CORE35]] D16): imported by `*.postgres.test.ts` entry files only.
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vibase/db'
import { createOwnerTestDb, createTestDb, seedAgent, seedUser, truncateAll } from '@vibase/db/test'
import { postgresBinding } from '@vibase/storage-postgres'
import { createApp } from '../rest/app.js'
import { captureAs } from './capture-kit.js'
import type { ContractBackend, ContractTenant } from './contract.js'
import { withTenantDefaults } from './insert.js'
import { seedApiKey } from './keys.js'
import { seedTenant } from './tenant.js'
import { fakeUserAuthenticator, mintTestUserToken } from './user-auth.js'

/** The Postgres backend: `vault_app` pool, owner pool for truncation and reads, the storage-postgres binding. */
export function postgresBackend(): ContractBackend {
  return {
    name: 'postgres',
    async open(registry) {
      const db = createTestDb()
      const owner = createOwnerTestDb()
      const storage = postgresBinding(db)
      const app = createApp({ registry, userAuthenticator: fakeUserAuthenticator(), storage: () => storage })
      const agents = new Map<string, { id: string; key: string }>()
      const agentFor = async (t: ContractTenant, scopes: string[]) => {
        const k = `${t.organizationId}:${scopes.join(',')}`
        let agent = agents.get(k)
        if (!agent) {
          const row = await seedAgent(db, { organizationId: t.organizationId, createdBy: t.userId, scopes })
          const key = await seedApiKey(db, { organizationId: t.organizationId, agentId: row.id, createdBy: t.userId })
          agent = { id: row.id, key: key.key }
          agents.set(k, agent)
        }
        return agent
      }
      return {
        app,
        db,
        owner,
        async reset() {
          await truncateAll(owner)
          agents.clear()
          return { a: await seedTenant(db, 'A'), b: await seedTenant(db, 'B') }
        },
        async close() {
          await db.destroy()
          await owner.destroy()
        },
        async call(t, actor, scopes, method, path, body) {
          const token = actor === 'agent' ? (await agentFor(t, scopes)).key : mintTestUserToken({ userId: t.userId, organizationId: t.organizationId, scopes })
          return app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        },
        async principalId(t, actor, scopes) {
          return actor === 'agent' ? (await agentFor(t, scopes)).id : t.userId
        },
        async seedMember(t, role) {
          const u = await seedUser(db, { organizationId: t.organizationId, role })
          const m = await owner.selectFrom('memberships').select('id').where('user_id', '=', u.id).executeTakeFirstOrThrow()
          return { userId: u.id, membershipId: m.id }
        },
        async insert(t, table, row) {
          const full = withTenantDefaults(table, row, t)
          const cols = Object.keys(full)
          const res = await sql<Record<string, any>>`insert into ${sql.table(table)} (${sql.join(cols.map((c) => sql.ref(c)))}) values (${sql.join(cols.map((c) => sql`${full[c]}`))}) returning *`.execute(owner)
          return res.rows[0]!
        },
        capture: (t, input) => captureAs(storage, t, input),
        eventsOf: (id) => owner.selectFrom('events').selectAll().where('resource_id', '=', id).orderBy('id').execute(),
        countEvents: async () => Number((await owner.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
        countRows: async (table) =>
          Number((await (owner as unknown as Kysely<Record<string, Record<string, unknown>>>).selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      }
    },
  }
}

