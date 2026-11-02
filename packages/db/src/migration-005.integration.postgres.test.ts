import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { withOrganization } from './tenancy.js'
import { createOwnerTestDb, createTestDb, seedAgent, seedOrganization, seedUser, truncateAll } from './test/index.js'
import type { Database } from './types.js'

let pool: pg.Pool
let db: Kysely<Database>
let owner: Kysely<Database>

beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
  db = createTestDb()
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await pool.end()
  await db.destroy()
  await owner.destroy()
})
beforeEach(async () => {
  await truncateAll(owner)
})

async function q<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<R[]> {
  return (await pool.query<R>(text, values)).rows
}

async function rolledBack<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    return await fn(c)
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }
}

async function sqlstate(fn: (c: pg.PoolClient) => Promise<unknown>): Promise<string | undefined> {
  return rolledBack(async (c) => {
    try {
      await fn(c)
      return undefined
    } catch (e) {
      return (e as { code?: string }).code
    }
  })
}

/** SQLSTATE of an error thrown by `fn` run as a tenant (the production path). */
async function tenantState(
  ctx: { principalId: string; organizationId: string },
  fn: (trx: import('kysely').Transaction<Database>) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await withOrganization(db, ctx, fn)
    return undefined
  } catch (e) {
    return (e as { code?: string }).code
  }
}

const principal = async (c: pg.PoolClient, kind = 'user') =>
  (await c.query(`INSERT INTO principals (kind) VALUES ($1) RETURNING id`, [kind])).rows[0].id as string
const priv = async (role: string, table: string, priv: string) =>
  (await q<{ p: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS p`, [role, table, priv]))[0]!.p
const colPriv = async (role: string, table: string, col: string, priv: string) =>
  (await q<{ p: boolean }>(`SELECT has_column_privilege($1, $2, $3, $4) AS p`, [role, table, col, priv]))[0]!.p

describe('migration 005 directory', () => {
  it('organisation link columns', async () => {
    const rows = await q<{ column_name: string; udt_name: string; is_nullable: string }>(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name IN ('auth_provider', 'auth_org_id') ORDER BY column_name`,
    )
    expect(rows).toEqual([
      { column_name: 'auth_org_id', udt_name: 'text', is_nullable: 'YES' },
      { column_name: 'auth_provider', udt_name: 'text', is_nullable: 'YES' },
    ])
  })

  it('link pair', async () => {
    expect(await sqlstate((c) => c.query(`INSERT INTO organizations (name, auth_org_id) VALUES ('o', 'org_1')`))).toBe('23514')
  })

  it('link unique', async () => {
    expect(
      await sqlstate(async (c) => {
        await c.query(`INSERT INTO organizations (name, auth_provider, auth_org_id) VALUES ('o', 'clerk', 'org_1')`)
        await c.query(`INSERT INTO organizations (name, auth_provider, auth_org_id) VALUES ('p', 'clerk', 'org_1')`)
      }),
    ).toBe('23505')
  })

  it('unlinked organisations', async () => {
    expect(
      await sqlstate(async (c) => {
        await c.query(`INSERT INTO organizations (name) VALUES ('o')`)
        await c.query(`INSERT INTO organizations (name) VALUES ('p')`)
      }),
    ).toBeUndefined()
  })

  it('system kind', async () => {
    expect(await sqlstate((c) => principal(c, 'system'))).toBeUndefined()
    expect(await sqlstate((c) => principal(c, 'robot'))).toBe('23514')
  })

  it('one system principal', async () => {
    expect(
      await sqlstate(async (c) => {
        await principal(c, 'system')
        await principal(c, 'system')
      }),
    ).toBe('23505')
  })

  it('system readable in a tenant', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    await q(`INSERT INTO principals (kind) VALUES ('system')`)
    const rows = await withOrganization(db, { principalId: u.id, organizationId: o.id }, (trx) =>
      trx.selectFrom('principals').select('id').where('kind', '=', 'system').execute(),
    )
    expect(rows).toHaveLength(1)
  })

  it('tenant cannot insert system', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    expect(
      await tenantState({ principalId: u.id, organizationId: o.id }, (trx) =>
        trx.insertInto('principals').values({ kind: 'system' }).execute(),
      ),
    ).toBe('42501')
  })

  it('no invitations', async () => {
    expect((await q<{ r: string | null }>(`SELECT to_regclass('public.invitations')::text AS r`))[0]!.r).toBeNull()
  })

  it('memberships: tenants read, never write', async () => {
    expect(await priv('vault_authenticated', 'memberships', 'SELECT')).toBe(true)
    for (const p of ['INSERT', 'UPDATE', 'DELETE']) expect(await priv('vault_authenticated', 'memberships', p), p).toBe(false)
    for (const col of ['role', 'deleted_at', 'user_id', 'organization_id', 'created_by'])
      expect(await colPriv('vault_authenticated', 'memberships', col, 'UPDATE'), col).toBe(false)
  })

  it('agents grants', async () => {
    expect(await priv('vault_authenticated', 'agents', 'INSERT')).toBe(true)
    for (const col of ['name', 'scopes', 'disabled_at']) expect(await colPriv('vault_authenticated', 'agents', col, 'UPDATE'), col).toBe(true)
    for (const col of ['id', 'organization_id', 'created_by']) expect(await colPriv('vault_authenticated', 'agents', col, 'UPDATE'), col).toBe(false)
  })

  it('api_keys grants', async () => {
    const cols = ['id', 'created_at', 'updated_at', 'organization_id', 'agent_id', 'prefix', 'last_used_at', 'revoked_at', 'expires_at', 'created_by']
    for (const col of cols) expect(await colPriv('vault_authenticated', 'api_keys', col, 'SELECT'), col).toBe(true)
    expect(await colPriv('vault_authenticated', 'api_keys', 'key_hash', 'SELECT')).toBe(false)
    expect(await priv('vault_authenticated', 'api_keys', 'INSERT')).toBe(true)
    expect(await colPriv('vault_authenticated', 'api_keys', 'revoked_at', 'UPDATE')).toBe(true)
    for (const col of ['prefix', 'last_used_at', 'key_hash']) expect(await colPriv('vault_authenticated', 'api_keys', col, 'UPDATE'), col).toBe(false)
  })

  it('principals insert policy', async () => {
    const [p] = await q<{ policyname: string; cmd: string; roles: string[]; with_check: string }>(
      `SELECT policyname, cmd, roles::text[] AS roles, with_check FROM pg_policies WHERE tablename = 'principals' AND policyname = 'principals_insert_agent'`,
    )
    expect(p).toMatchObject({ cmd: 'INSERT', roles: ['vault_authenticated'] })
    expect(p!.with_check).toContain('kind')
    expect(p!.with_check).toContain('current_organization_id')
    expect(await priv('vault_authenticated', 'principals', 'INSERT')).toBe(true)
  })

  it('an agent principal can be created inside a tenant', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    const id = await withOrganization(db, { principalId: u.id, organizationId: o.id }, async (trx) => {
      const { id } = (await sql<{ id: string }>`SELECT uuid_generate_v7() AS id`.execute(trx)).rows[0]!
      await trx.insertInto('principals').values({ id, kind: 'agent' }).execute()
      await trx.insertInto('agents').values({ id, organization_id: o.id, name: 'bot', created_by: u.id }).execute()
      return id
    })
    const seen = await withOrganization(db, { principalId: u.id, organizationId: o.id }, (trx) =>
      trx.selectFrom('principals').select('id').where('id', '=', id).execute(),
    )
    expect(seen).toHaveLength(1)
  })

  it('a user principal is refused', async () => {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    expect(
      await tenantState({ principalId: u.id, organizationId: o.id }, (trx) => trx.insertInto('principals').values({ kind: 'user' }).execute()),
    ).toBe('42501')
  })

  async function seededKey() {
    const o = await seedOrganization(db)
    const u = await seedUser(db, { organizationId: o.id, role: 'owner' })
    const a = await seedAgent(db, { organizationId: o.id, createdBy: u.id })
    const ctx = { principalId: u.id, organizationId: o.id }
    await sql`INSERT INTO api_keys (organization_id, agent_id, key_hash, prefix, created_by) VALUES (${o.id}, ${a.id}, ${'h-' + a.id}, 'vk_abcdefgh', ${u.id})`.execute(owner)
    return ctx
  }

  it('key hash is hidden', async () => {
    const ctx = await seededKey()
    expect(await tenantState(ctx, (trx) => sql`SELECT key_hash FROM api_keys`.execute(trx))).toBe('42501')
    expect(await tenantState(ctx, (trx) => sql`SELECT id, prefix FROM api_keys`.execute(trx))).toBeUndefined()
  })

  it('key columns are frozen', async () => {
    const ctx = await seededKey()
    expect(await tenantState(ctx, (trx) => sql`UPDATE api_keys SET prefix = 'x'`.execute(trx))).toBe('42501')
    expect(await tenantState(ctx, (trx) => sql`UPDATE api_keys SET revoked_at = now()`.execute(trx))).toBeUndefined()
  })
})
