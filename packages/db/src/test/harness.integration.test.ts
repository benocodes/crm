import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from './index.js'
import type { Database } from '../types.js'

describe('test harness', () => {
  let db: Kysely<Database>
  let owner: Kysely<Database>

  beforeAll(() => {
    db = createTestDb()
    owner = createOwnerTestDb()
  })
  afterAll(async () => {
    await db.destroy()
    await owner.destroy()
  })
  beforeEach(async () => {
    await truncateAll(owner)
  })

  it('app pool is vault_app', async () => {
    const { rows } = await sql<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(db)
    expect(rows[0]).toEqual({ current_user: 'vault_app', rolsuper: false, rolbypassrls: false })
  })

  it('nothing preset', async () => {
    const { rows } = await sql<{ o: string | null; p: string | null }>`
      SELECT current_setting('app.organization_id', true) AS o, current_setting('app.principal_id', true) AS p`.execute(db)
    expect(rows[0]!.o ?? '').toBe('')
    expect(rows[0]!.p ?? '').toBe('')
  })

  it('no role preset', async () => {
    const { rows } = await sql<{ current_user: string }>`SELECT current_user`.execute(db)
    expect(rows[0]!.current_user).toBe('vault_app')
  })

  it('unwrapped read fails', async () => {
    await expect(db.selectFrom('tasks').selectAll().execute()).rejects.toMatchObject({ code: '42501' })
  })

  it('unwrapped write fails', async () => {
    await expect(db.insertInto('organizations').values({ name: 'x' }).execute()).rejects.toMatchObject({
      code: '42501',
    })
  })

  async function baseTables(): Promise<string[]> {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('kysely_migration', 'kysely_migration_lock')`.execute(owner)
    return rows.map((r) => r.table_name)
  }

  async function seedEverything() {
    const org = await seedOrganization(db, { name: 'Harness Org' })
    const user = await seedUser(db, { organizationId: org.id })
    await seedAgent(db, { organizationId: org.id, createdBy: user.id })
  }

  it('truncateAll covers every table', async () => {
    await seedEverything()
    await truncateAll(owner)
    const tables = await baseTables()
    expect(tables.length).toBeGreaterThanOrEqual(8)
    for (const t of tables) {
      const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(t)}`.execute(owner)
      expect(rows[0]!.n, t).toBe('0')
    }
  })

  it('truncateAll keeps migrations', async () => {
    await seedEverything()
    await truncateAll(owner)
    const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(owner)
    expect(rows.map((r) => r.name)).toContainEqual(expect.stringMatching(/_001_baseline$/))
  })

  it('missing URL is loud', () => {
    const saved = { a: process.env.TEST_APP_DATABASE_URL, o: process.env.TEST_DATABASE_URL }
    delete process.env.TEST_APP_DATABASE_URL
    delete process.env.TEST_DATABASE_URL
    try {
      expect(() => createTestDb()).toThrow(/TEST_APP_DATABASE_URL/)
    } finally {
      if (saved.a !== undefined) process.env.TEST_APP_DATABASE_URL = saved.a
      if (saved.o !== undefined) process.env.TEST_DATABASE_URL = saved.o
    }
  })

  it('refuses a non-test database', () => {
    const saved = process.env.TEST_DATABASE_URL
    process.env.TEST_DATABASE_URL = 'postgresql://localhost/vault_dev'
    try {
      expect(() => createOwnerTestDb()).toThrow('refusing: database "vault_dev" is not a test database')
    } finally {
      process.env.TEST_DATABASE_URL = saved
    }
  })
})
