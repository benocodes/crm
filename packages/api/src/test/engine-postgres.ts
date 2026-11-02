// Test-only. The Postgres engine of the both-engine storage suites ([[CORE35]] D16): `vault_app` (no presets: invariant 2)
// and the owner pool for raw reads. Loaded by `openEngines(['postgres'])` only, so D1 runs never import it.
import { sql } from 'kysely'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import { uuidv7 } from '@vault/storage'
import { postgresBinding } from '@vault/storage-postgres'
import { LINK, SEED_AT, decodeRow, kindsOf, shared, withDefaults, type Engine, type RawRow } from './engines.js'

export async function openPostgres(opts: { maxConnections?: number; maxSetSize?: number }): Promise<Engine> {
  const app = createTestDb({ max: opts.maxConnections ?? 6 })
  const owner = createOwnerTestDb()
  const binding = postgresBinding(app, opts.maxSetSize === undefined ? {} : { maxSetSize: opts.maxSetSize })
  const e: Engine = {
    name: 'postgres',
    binding,
    organizationId: '',
    userId: '',
    user2Id: '',
    agentId: '',
    ...LINK,
    app,
    owner,
    async reset() {
      await truncateAll(owner)
      const org = await seedOrganization(app, { name: 'Engine org', authProvider: LINK.authProvider, authOrgId: LINK.authOrgId })
      const user = await seedUser(app, { organizationId: org.id, role: 'owner', authSubject: LINK.userSubject })
      const user2 = await seedUser(app, { organizationId: org.id, authSubject: LINK.user2Subject })
      const agent = await seedAgent(app, { organizationId: org.id, createdBy: user.id })
      // The seeds' defaults are the database clock; stamp them like D1's seeds so both engines start from the same instant (CORE41 P17).
      for (const t of ['organizations', 'users', 'memberships', 'agents']) {
        await sql`update ${sql.table(t)} set created_at = ${SEED_AT}, updated_at = ${SEED_AT}`.execute(owner)
      }
      await sql`update principals set created_at = ${SEED_AT}`.execute(owner)
      Object.assign(e, { organizationId: org.id, userId: user.id, user2Id: user2.id, agentId: agent.id })
    },
    async close() {
      await app.destroy()
      await owner.destroy()
    },
    ...shared(() => e),
    async tasks() {
      return (await sql<RawRow>`select id, title, status, notes, due_at, completed_at, assignee_id, deleted_at, created_at, updated_at from tasks order by ctid`.execute(owner)).rows
    },
    async events() {
      return (await sql<RawRow>`select * from events order by ctid`.execute(owner)).rows
    },
    async insertTask(row) {
      const at = row.at ?? '2026-10-22T08:00:00.000Z'
      await sql`insert into tasks (id, organization_id, title, status, completed_at, created_by, created_at, updated_at) values (${row.id}, ${e.organizationId}, ${row.title}, ${row.status ?? 'open'}, ${row.completed_at ?? null}, ${e.userId}, ${at}, ${at})`.execute(owner)
    },
    async rows(table) {
      kindsOf(table)
      return (await sql<RawRow>`select * from ${sql.table(table)} order by ctid`.execute(owner)).rows.map((r) => decodeRow(table, r))
    },
    async insert(table, row) {
      const full = withDefaults(e, table, row)
      const cols = Object.keys(full)
      const res = await sql<RawRow>`insert into ${sql.table(table)} (${sql.join(cols.map((c) => sql.ref(c)))}) values (${sql.join(cols.map((c) => sql`${full[c]}`))}) returning *`.execute(owner)
      return decodeRow(table, res.rows[0]!)
    },
    async seedMember(role = 'member', opts = {}) {
      const u = await seedUser(app, { organizationId: e.organizationId, role, ...(opts.subject ? { authSubject: opts.subject } : {}), ...(opts.email ? { email: opts.email } : {}) })
      const m = await sql<{ id: string }>`select id from memberships where user_id = ${u.id}`.execute(owner)
      return { userId: u.id, membershipId: m.rows[0]!.id }
    },
    async update(table, id, patch) {
      kindsOf(table)
      const cols = Object.keys(patch)
      await sql`update ${sql.table(table)} set ${sql.join(cols.map((c) => sql`${sql.ref(c)} = ${patch[c]}`))} where id = ${id}`.execute(owner)
    },
    betweenPlanAndCommit() {
      throw new Error('betweenPlanAndCommit is a D1 device: Postgres plan and commit share one locked transaction (races are covered by D13 trials)')
    },
  }
  return e
}

