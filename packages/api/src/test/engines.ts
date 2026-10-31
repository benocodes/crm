// Test-only. One harness over both engines for the storage-level suites ([[CORE35]] D16): the same program
// runs on Postgres (`vault_app`, no presets: invariant 2) and on a local D1 binding, with the same raw reads.
import { sql, type Kysely } from 'kysely'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from '@vault/db/test'
import type { Database } from '@vault/db'
import { COLUMN_KINDS, uuidv7, type ColumnKind, type ExecutionResult, type PreparedOperation, type StorageBinding, type StorageIdentity } from '@vault/storage'
import { postgresBinding } from '@vault/storage-postgres'
import { d1Binding, type D1Like, type D1PreparedLike } from '@vault/storage-d1'
import { clearD1, openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { seedAgent as seedD1Agent, seedDeployment, seedMembership, seedPrincipal } from '@vault/storage-d1/test/seed'
import { execute } from '@vault/storage'
import { ScopeSet } from '../scopes.js'
import { d1Value } from './insert.js'
import type { PreparedEnv } from '../storage/definition.js'

export type RawRow = Record<string, any>
export interface Engine {
  name: 'postgres' | 'd1'
  binding: StorageBinding
  organizationId: string
  userId: string
  user2Id: string
  agentId: string
  /** The organisation's provider link and the two seeded users' login subjects (CORE41 P17): both engines link them on reset. */
  authProvider: 'clerk'
  authOrgId: 'org_engine'
  userSubject: 'user_engine_1'
  user2Subject: 'user_engine_2'
  /** Postgres only: the `vault_app` pool (unwrapped queries must fail with 42501) and the owner pool. */
  app?: Kysely<Database>
  owner?: Kysely<Database>
  d1?: D1Like
  reset(): Promise<void>
  close(): Promise<void>
  /** A unit environment for the tenant's user (or the agent) with an injected clock and a fresh id source. */
  env(over?: Partial<PreparedEnv> & { as?: 'user' | 'agent' }): PreparedEnv
  run<T>(op: PreparedOperation<T>, as?: 'user' | 'agent'): Promise<ExecutionResult<T>>
  /** Runs `op` as an explicit storage identity (account or internal units, CORE41). */
  runAs<T>(identity: StorageIdentity, op: PreparedOperation<T>): Promise<ExecutionResult<T>>
  tasks(): Promise<RawRow[]>
  events(): Promise<RawRow[]>
  /** Inserts a task row directly (fixture setup, bypassing the program under test). */
  insertTask(row: { id: string; title: string; status?: 'open' | 'done'; completed_at?: string | null; at?: string }): Promise<void>
  /** Raw rows of a modelled table in write order (`ctid` on Postgres, `rowid` on D1); booleans and JSON decoded, timestamps as ISO text. */
  rows(table: string): Promise<RawRow[]>
  /**
   * Inserts a row directly (setup only, bypassing the program under test) through the owner pool or D1. Fills
   * `id`, `organization_id`, `created_by`, `created_at` and `updated_at` when the table has them and the row omits them.
   */
  insert(table: string, row: Record<string, unknown>): Promise<RawRow>
  /**
   * Seeds a user with a live membership in the engine's organisation (setup only). Postgres: `seedUser`; D1: principal,
   * user and membership rows. `subject` links the login (provider `clerk`). Returns both ids.
   */
  seedMember(role?: 'owner' | 'member', opts?: { subject?: string; email?: string }): Promise<{ userId: string; membershipId: string }>
  /** Updates a row directly by id (setup only, bypassing the program under test): the device for a concurrent writer. */
  update(table: string, id: string, patch: Record<string, unknown>): Promise<void>
  /** D1 only: `hook` runs once, after the next unit's plan reads and before its commit batch (deterministic drift). */
  betweenPlanAndCommit(hook: () => Promise<void>): void
}

const SEED_AT = '2026-10-22T08:00:00.000Z'
const LINK = { authProvider: 'clerk', authOrgId: 'org_engine', userSubject: 'user_engine_1', user2Subject: 'user_engine_2' } as const
const kindsOf = (table: string): Record<string, ColumnKind> => {
  const kinds = (COLUMN_KINDS as Record<string, Record<string, ColumnKind>>)[table]
  if (!kinds) throw new Error(`no modelled table "${table}"`)
  return kinds
}
/** Decodes a raw row to the shape both engines share: ISO timestamps, JS booleans, parsed JSON. */
function decodeRow(table: string, row: RawRow): RawRow {
  const kinds = kindsOf(table)
  const out: RawRow = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = null
    else if (kinds[k] === 'timestamp') out[k] = v instanceof Date ? v.toISOString() : v
    else if (kinds[k] === 'boolean') out[k] = v === true || v === 1
    else if (kinds[k] === 'json') out[k] = typeof v === 'string' ? JSON.parse(v) : v
    else if (kinds[k] === 'string_array') out[k] = typeof v === 'string' ? JSON.parse(v) : v
    else if (kinds[k] === 'integer') out[k] = typeof v === 'string' ? Number(v) : v
    else out[k] = v
  }
  return out
}
function withDefaults(e: Engine, table: string, row: Record<string, unknown>): Record<string, unknown> {
  const kinds = kindsOf(table)
  const out = { ...row }
  if ('id' in kinds) out.id ??= uuidv7()
  if ('organization_id' in kinds) out.organization_id ??= e.organizationId
  if ('created_by' in kinds) out.created_by ??= e.userId
  if ('created_at' in kinds) out.created_at ??= SEED_AT
  if ('updated_at' in kinds) out.updated_at ??= SEED_AT
  return out
}

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
const scopes = () =>
  ScopeSet.parse(['tasks:read', 'tasks:write', 'companies:read', 'companies:write', 'contacts:read', 'contacts:write', 'agents:read', 'agents:write', 'members:read', 'messages:read', 'interactions:read', 'files:read', 'associations:read', 'associations:write'])

export async function openEngines(opts: { maxConnections?: number; maxSetSize?: number } = {}): Promise<Engine[]> {
  return [await openPostgres(opts), await openD1(opts)]
}

/** The D1 engine alone, for suites of D1-only features (no Postgres table): CORE62's associations. */
export async function openD1Engine(opts: { maxSetSize?: number } = {}): Promise<Engine> {
  const e = await openD1(opts)
  await e.reset()
  return e
}

async function openPostgres(opts: { maxConnections?: number; maxSetSize?: number }): Promise<Engine> {
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

/** A D1 whose next unit pauses between its plan reads and its commit batch to run `hook`. */
function interceptD1(real: D1Like, pending: { hook: (() => Promise<void>) | null }): D1Like {
  const sqlOf = new WeakMap<object, string>()
  const isRead = (s: D1PreparedLike) => /^\s*select\b/i.test(sqlOf.get(s) ?? '')
  return {
    prepare(query: string) {
      const p = real.prepare(query)
      // The runtime hands `batch` the BOUND statements, so remember the SQL on what `bind` returns.
      return {
        bind: (...values: unknown[]) => {
          const bound = p.bind(...values)
          sqlOf.set(bound, query)
          return bound
        },
        run: () => p.run(),
        all: () => p.all(),
        first: () => p.first(),
      } as D1PreparedLike
    },
    async batch(statements: D1PreparedLike[]) {
      const reads = statements.length > 0 && statements.every(isRead)
      const hook = pending.hook
      if (hook && !reads) {
        // No read batch ran for this unit: run the hook right before the commit batch.
        pending.hook = null
        await hook()
        return real.batch(statements)
      }
      const out = await real.batch(statements)
      if (hook && reads) {
        pending.hook = null
        await hook()
      }
      return out
    },
  } as D1Like
}

async function openD1(opts: { maxSetSize?: number }): Promise<Engine> {
  const local: LocalD1 = await openLocalD1(['ENGINE'])
  const d1 = local.bindings.ENGINE!
  const pending: { hook: (() => Promise<void>) | null } = { hook: null }
  const e: Engine = {
    name: 'd1',
    binding: undefined as never,
    organizationId: '',
    userId: '',
    user2Id: '',
    agentId: '',
    ...LINK,
    d1,
    async reset() {
      await clearD1(d1)
      const ids = { organizationId: uuidv7(), userId: uuidv7(), user2Id: uuidv7(), agentId: uuidv7() }
      await seedDeployment(d1, { organizationId: ids.organizationId, provider: LINK.authProvider, externalId: LINK.authOrgId })
      await seedPrincipal(d1, { id: ids.userId, kind: 'user', authSubject: LINK.userSubject })
      await seedPrincipal(d1, { id: ids.user2Id, kind: 'user', authSubject: LINK.user2Subject })
      await seedMembership(d1, { organizationId: ids.organizationId, userId: ids.userId, role: 'owner' })
      await seedMembership(d1, { organizationId: ids.organizationId, userId: ids.user2Id, role: 'member' })
      await seedD1Agent(d1, { id: ids.agentId, organizationId: ids.organizationId, createdBy: ids.userId })
      pending.hook = null
      Object.assign(e, ids, { binding: d1Binding(interceptD1(d1, pending), { organizationId: ids.organizationId, authProvider: LINK.authProvider, authOrgId: LINK.authOrgId, ...(opts.maxSetSize === undefined ? {} : { maxSetSize: opts.maxSetSize }) }) })
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
    async rows(table) {
      kindsOf(table)
      return ((await d1.prepare(`select * from "${table}" order by rowid`).all()).results as RawRow[]).map((r) => decodeRow(table, r))
    },
    async insert(table, row) {
      const full = withDefaults(e, table, row)
      const cols = Object.keys(full)
      const values = cols.map((c) => d1Value(full[c]))
      await d1.prepare(`insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`).bind(...values).run()
      return decodeRow(table, full as RawRow)
    },
    async seedMember(role = 'member', opts = {}) {
      const userId = uuidv7()
      await seedPrincipal(d1, { id: userId, kind: 'user', ...(opts.subject ? { authSubject: opts.subject } : {}), ...(opts.email ? { email: opts.email } : {}) })
      const membershipId = await seedMembership(d1, { organizationId: e.organizationId, userId, role })
      return { userId, membershipId }
    },
    async update(table, id, patch) {
      kindsOf(table)
      const cols = Object.keys(patch)
      const values = cols.map((c) => d1Value(patch[c]))
      await d1.prepare(`update "${table}" set ${cols.map((c) => `"${c}" = ?`).join(', ')} where id = ?`).bind(...values, id).run()
    },
    betweenPlanAndCommit(hook) {
      pending.hook = hook
    },
  }
  return e
}

function shared(self: () => Engine): Pick<Engine, 'env' | 'run' | 'runAs'> {
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
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        ...rest,
      }
    },
    run(op, as = 'user') {
      const e = self()
      return execute(e.binding, { kind: 'tenant', actorId: as === 'agent' ? e.agentId : e.userId, organizationId: e.organizationId }, op)
    },
    runAs(identity, op) {
      return execute(self().binding, identity, op)
    },
  }
}
