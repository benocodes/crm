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
const org = async (c: pg.PoolClient) => (await c.query(`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)).rows[0].id as string
const invite = (c: pg.PoolClient, o: string, by: string, email: string, extra = '') =>
  c.query(
    `INSERT INTO invitations (organization_id, email, role, expires_at, created_by ${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1, $2, 'member', now() + interval '14 days', $3 ${extra ? ', ' + extra.split('=')[1] : ''})`,
    [o, email, by],
  )

const priv = async (role: string, table: string, priv: string) =>
  (await q<{ p: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS p`, [role, table, priv]))[0]!.p
const colPriv = async (role: string, table: string, col: string, priv: string) =>
  (await q<{ p: boolean }>(`SELECT has_column_privilege($1, $2, $3, $4) AS p`, [role, table, col, priv]))[0]!.p

describe('migration 005 administration', () => {
  it('invitations columns', async () => {
    const rows = await q<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'invitations' ORDER BY column_name`,
    )
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    expect(Object.keys(by).sort()).toEqual(
      ['accepted_at', 'accepted_by', 'created_at', 'created_by', 'deleted_at', 'email', 'expires_at', 'id', 'organization_id', 'role', 'updated_at'],
    )
    const shape = (n: string) => [by[n]!.udt_name, by[n]!.is_nullable]
    expect(shape('id')).toEqual(['uuid', 'NO'])
    expect(by.id!.column_default).toContain('uuid_generate_v7')
    expect(shape('organization_id')).toEqual(['uuid', 'NO'])
    expect(by.organization_id!.column_default).toBeNull()
    expect(shape('email')).toEqual(['citext', 'NO'])
    expect(shape('role')).toEqual(['text', 'NO'])
    expect(shape('expires_at')).toEqual(['timestamptz', 'NO'])
    expect(shape('accepted_at')).toEqual(['timestamptz', 'YES'])
    expect(shape('accepted_by')).toEqual(['uuid', 'YES'])
    expect(shape('created_by')).toEqual(['uuid', 'NO'])
    expect(shape('deleted_at')).toEqual(['timestamptz', 'YES'])
    expect(shape('created_at')).toEqual(['timestamptz', 'NO'])
    expect(shape('updated_at')).toEqual(['timestamptz', 'NO'])
  })

  it('role check', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const p = await principal(c)
        await c.query(
          `INSERT INTO invitations (organization_id, email, role, expires_at, created_by) VALUES ($1, 'a@x.test', 'admin', now(), $2)`,
          [o, p],
        )
      }),
    ).toBe('23514')
  })

  it('accepted pair', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const p = await principal(c)
        await invite(c, o, p, 'a@x.test', 'accepted_at=now()')
      }),
    ).toBe('23514')
  })

  it('pending unique, case-insensitive', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const p = await principal(c)
        await invite(c, o, p, 'A@x.test')
        await invite(c, o, p, 'a@x.test')
      }),
    ).toBe('23505')
  })

  it('accepted or deleted frees the slot', async () => {
    for (const variant of ['accepted', 'deleted']) {
      const state = await sqlstate(async (c) => {
        const o = await org(c)
        const p = await principal(c)
        await invite(c, o, p, 'a@x.test')
        if (variant === 'accepted') {
          await c.query(`INSERT INTO users (id, email) VALUES ($1, 'u@x.test')`, [p])
          await c.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $1`, [p])
        } else await c.query(`UPDATE invitations SET deleted_at = now()`)
        await invite(c, o, p, 'a@x.test')
      })
      expect(state, variant).toBeUndefined()
    }
  })

  it('other organisation', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const o2 = await org(c)
        const p = await principal(c)
        await invite(c, o, p, 'a@x.test')
        await invite(c, o2, p, 'a@x.test')
      }),
    ).toBeUndefined()
  })

  it('accepted_by is a user', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const p = await principal(c)
        const agent = await principal(c, 'agent')
        await c.query(
          `INSERT INTO invitations (organization_id, email, role, expires_at, created_by, accepted_at, accepted_by)
           VALUES ($1, 'a@x.test', 'member', now(), $2, now(), $3)`,
          [o, p, agent],
        )
      }),
    ).toBe('23503')
  })

  it('indexes', async () => {
    const rows = await q<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'invitations'`)
    const by = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
    expect(by.idx_invitations_pending_unique).toMatch(/UNIQUE/)
    expect(by.idx_invitations_pending_unique).toMatch(/deleted_at IS NULL/)
    expect(by.idx_invitations_pending_unique).toMatch(/accepted_at IS NULL/)
    expect(by.idx_invitations_email).toBeDefined()
  })

  it('invitations RLS', async () => {
    const [c] = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'invitations'`,
    )
    expect(c).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const pol = await q<{ policyname: string; cmd: string; roles: string[] }>(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'invitations'`,
    )
    expect(pol).toEqual([{ policyname: 'invitations_tenant', cmd: 'ALL', roles: ['vault_authenticated'] }])
  })

  it('invitations grants', async () => {
    for (const p of ['SELECT', 'INSERT', 'UPDATE']) expect(await priv('vault_service', 'invitations', p), p).toBe(true)
    expect(await priv('vault_authenticated', 'invitations', 'SELECT')).toBe(true)
    expect(await priv('vault_authenticated', 'invitations', 'INSERT')).toBe(true)
    expect(await colPriv('vault_authenticated', 'invitations', 'deleted_at', 'UPDATE')).toBe(true)
    for (const col of ['email', 'accepted_at', 'accepted_by', 'role'])
      expect(await colPriv('vault_authenticated', 'invitations', col, 'UPDATE'), col).toBe(false)
    for (const r of ['vault_service', 'vault_authenticated']) expect(await priv(r, 'invitations', 'DELETE'), r).toBe(false)
  })

  it('memberships grants', async () => {
    for (const col of ['role', 'deleted_at']) expect(await colPriv('vault_authenticated', 'memberships', col, 'UPDATE'), col).toBe(true)
    for (const col of ['user_id', 'organization_id', 'created_by']) expect(await colPriv('vault_authenticated', 'memberships', col, 'UPDATE'), col).toBe(false)
    expect(await priv('vault_authenticated', 'memberships', 'INSERT')).toBe(false)
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
