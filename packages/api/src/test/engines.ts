// Test-only. One harness over both engines for the storage-level suites ([[CORE35]] D16): the same program
// runs on Postgres (`vault_app`, no presets: invariant 2) and on a local D1 binding, with the same raw reads.
import { sql, type Kysely } from 'kysely'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import type { Database } from '@vault/db'
import { uuidv7, type ExecutionResult, type PreparedOperation, type StorageBinding } from '@vault/storage'
import { postgresBinding } from '@vault/storage-postgres'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vault/storage-d1/test/seed'
import { execute } from '@vault/storage'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'

export type RawRow = Record<string, any>
export interface Engine {
  name: 'postgres' | 'd1'
  binding: StorageBinding
  organizationId: string
  userId: string
  user2Id: string
  agentId: string
  /** Postgres only: the `vault_app` pool (unwrapped queries must fail with 42501) and the owner pool. */
  app?: Kysely<Database>
  owner?: Kysely<Database>
  d1?: D1Like
  reset(): Promise<void>
  close(): Promise<void>
  /** A unit environment for the tenant's user (or the agent) with an injected clock and a fresh id source. */
  env(over?: Partial<PreparedEnv> & { as?: 'user' | 'agent' }): PreparedEnv
  run<T>(op: PreparedOperation<T>, as?: 'user' | 'agent'): Promise<ExecutionResult<T>>
  tasks(): Promise<RawRow[]>
  events(): Promise<RawRow[]>
  /** Inserts a task row directly (fixture setup, bypassing the program under test). */
  insertTask(row: { id: string; title: string; status?: 'open' | 'done'; completed_at?: string | null; at?: string }): Promise<void>
}

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
const scopes = () => ScopeSet.parse(['tasks:read', 'tasks:write'])

export async function openEngines(opts: { maxConnections?: number } = {}): Promise<Engine[]> {
  return [await openPostgres(opts), await openD1()]
}

async function openPostgres(opts: { maxConnections?: number }): Promise<Engine> {
  const app = createTestDb({ max: opts.maxConnections ?? 6 })
  const owner = createOwnerTestDb()
  const binding = postgresBinding(app)
  const e: Engine = {
    name: 'postgres',
    binding,
    organizationId: '',
    userId: '',
    user2Id: '',
    agentId: '',
    app,
    owner,
    async reset() {
      // Guard: the production `updated_at` trigger must be on. A suite that disabled it and leaked the DDL would
      // mask the real timestamps (AGENTS.md invariant 2), so fail loudly instead of passing on leaked state.
      const { rows } = await sql<{ tgenabled: string }>`select tgenabled from pg_trigger where tgname = 'set_updated_at' and tgrelid = 'tasks'::regclass`.execute(owner)
      if (rows[0]?.tgenabled !== 'O') throw new Error(`tasks.set_updated_at trigger is not enabled (tgenabled=${rows[0]?.tgenabled}); run \`pnpm db:test:worktree\``)
      await truncateAll(owner)
      const org = await seedOrganization(app, { name: 'Engine org' })
      const user = await seedUser(app, { organizationId: org.id, role: 'owner' })
      const user2 = await seedUser(app, { organizationId: org.id })
      const agent = await seedAgent(app, { organizationId: org.id, createdBy: user.id })
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
  }
  return e
}

async function openD1(): Promise<Engine> {
  const local: LocalD1 = await openLocalD1(['ENGINE'])
  const d1 = local.bindings.ENGINE!
  const e: Engine = {
    name: 'd1',
    binding: undefined as never,
    organizationId: '',
    userId: '',
    user2Id: '',
    agentId: '',
    d1,
    async reset() {
      await clearD1(d1)
      const ids = { organizationId: uuidv7(), userId: uuidv7(), user2Id: uuidv7(), agentId: uuidv7() }
      await seedDeployment(d1, { organizationId: ids.organizationId })
      await seedPrincipal(d1, { id: ids.userId, kind: 'user' })
      await seedPrincipal(d1, { id: ids.user2Id, kind: 'user' })
      await seedPrincipal(d1, { id: ids.agentId, kind: 'agent' })
      Object.assign(e, ids, { binding: d1Binding(d1, { organizationId: ids.organizationId }) })
    },
    close: () => local.dispose(),
    ...shared(() => e),
    async tasks() {
      return (await d1.prepare('select * from tasks order by rowid').all()).results as RawRow[]
    },
    async events() {
      return ((await d1.prepare('select * from events order by rowid').all()).results as RawRow[]).map((r) => ({ ...r, before: parse(r.before), after: parse(r.after) }))
    },
    async insertTask(row) {
      const at = row.at ?? '2026-10-22T08:00:00.000Z'
      await d1.prepare('insert into tasks (id, organization_id, title, status, completed_at, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, e.organizationId, row.title, row.status ?? 'open', row.completed_at ?? null, e.userId, at, at)
        .run()
    },
  }
  return e
}

function shared(self: () => Engine): Pick<Engine, 'env' | 'run'> {
  return {
    env(over = {}) {
      const e = self()
      const kind = over.as ?? 'user'
      const now = over.now ?? new Date('2026-10-22T10:00:00.000Z')
      const { as: _as, ...rest } = over
      return {
        actor: { id: kind === 'agent' ? e.agentId : e.userId, kind },
        organizationId: e.organizationId,
        scopes: scopes(),
        now,
        newId: () => uuidv7(now),
        ...rest,
      }
    },
    run(op, as = 'user') {
      const e = self()
      return execute(e.binding, { actorId: as === 'agent' ? e.agentId : e.userId, organizationId: e.organizationId }, op)
    },
  }
}
