import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

let pool: pg.Pool
let tables: string[] = []

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT IN ('kysely_migration', 'kysely_migration_lock')`,
  )
  tables = rows.map((r) => r.table_name)
})
afterAll(async () => {
  await pool.end()
})

const q = async (text: string, values?: unknown[]) => (await pool.query(text, values)).rows

describe('schema invariants', () => {
  it('guard: the table list is not empty', () => {
    expect(tables.length).toBeGreaterThanOrEqual(8)
  })

  it('RLS everywhere', async () => {
    const rows = await q(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [tables],
    )
    expect(rows).toHaveLength(tables.length)
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true])
  })

  it('a policy everywhere', async () => {
    const rows = await q(`SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'`)
    const withPolicy = new Set(rows.map((r) => r.tablename))
    for (const t of tables) expect(withPolicy.has(t), t).toBe(true)
  })

  it('policies use the tenant function', async () => {
    const rows = await q(`SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      for (const expr of [r.qual, r.with_check]) {
        if (expr === null) continue
        expect(expr, r.policyname).toContain('current_organization_id')
        expect(expr, r.policyname).not.toContain('current_setting')
      }
    }
  })

  it('attribution', async () => {
    const rows = await q(
      `SELECT table_name, array_agg(column_name::text) AS cols FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1) GROUP BY table_name`,
      [tables],
    )
    const tenant = rows.filter((r) => r.cols.includes('organization_id'))
    expect(tenant.length).toBeGreaterThan(0)
    for (const r of tenant) {
      expect(r.cols.includes('created_by') || r.cols.includes('actor_id'), r.table_name).toBe(true)
    }
  })

  it('no tenant default', async () => {
    const rows = await q(
      `SELECT table_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'organization_id'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.column_default, r.table_name).toBeNull()
  })

  it('v7 ids', async () => {
    const rows = await q(
      `SELECT table_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'id' AND column_default IS NOT NULL AND table_name = ANY($1)`,
      [tables],
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.column_default, r.table_name).toContain('uuid_generate_v7')
  })

  it('no deletes for tenants', async () => {
    const rows = await q(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'vault_authenticated' AND table_schema = 'public' AND privilege_type IN ('DELETE', 'TRUNCATE')`,
    )
    expect(rows).toEqual([])
  })

  it('app role holds nothing', async () => {
    expect(await q(`SELECT * FROM information_schema.role_table_grants WHERE grantee = 'vault_app'`)).toEqual([])
  })

  it('events append-only', async () => {
    const rows = await q(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'vault_authenticated' AND table_name = 'events' AND table_schema = 'public'`,
    )
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT'])
  })

  it('updated_at has its trigger', async () => {
    const withCol = await q(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'updated_at' AND table_name = ANY($1)`,
      [tables],
    )
    expect(withCol.length).toBeGreaterThan(0)
    const trig = await q(
      `SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'set_updated_at'`,
    )
    const have = new Set(trig.map((r) => r.t))
    for (const r of withCol) expect(have.has(r.table_name), r.table_name).toBe(true)
  })
})
