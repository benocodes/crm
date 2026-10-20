import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

let pool: pg.Pool

beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
})
afterAll(async () => {
  await pool.end()
})

async function q<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<R[]> {
  return (await pool.query<R>(text, values)).rows
}

/** Run `fn` in a transaction on the owner pool and always roll back. */
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

/** The SQLSTATE of the error `fn` throws inside its own rolled-back transaction. */
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

const principal = async (c: pg.PoolClient) =>
  (await c.query(`INSERT INTO principals (kind) VALUES ('user') RETURNING id`)).rows[0].id as string
const org = async (c: pg.PoolClient) =>
  (await c.query(`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)).rows[0].id as string
const user = async (c: pg.PoolClient, email: string, provider: string | null = null, subject: string | null = null) => {
  const id = await principal(c)
  await c.query(`INSERT INTO users (id, email, auth_provider, auth_subject) VALUES ($1, $2, $3, $4)`, [id, email, provider, subject])
  return id
}

describe('migration 004 auth identity', () => {
  it('users columns', async () => {
    const rows = await q<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('auth_provider','auth_subject','email_verified')
       ORDER BY column_name`,
    )
    expect(rows.map((r) => [r.column_name, r.udt_name, r.is_nullable, r.column_default])).toEqual([
      ['auth_provider', 'text', 'YES', null],
      ['auth_subject', 'text', 'YES', null],
      ['email_verified', 'bool', 'NO', 'false'],
    ])
  })

  it('auth pair check', async () => {
    expect(
      await sqlstate(async (c) => {
        const id = await principal(c)
        await c.query(`INSERT INTO users (id, email, auth_provider) VALUES ($1, 'p@x.test', 'clerk')`, [id])
      }),
    ).toBe('23514')
  })

  it('auth pair unique', async () => {
    expect(
      await sqlstate(async (c) => {
        await user(c, 'a@x.test', 'clerk', 'user_1')
        await user(c, 'b@x.test', 'clerk', 'user_1')
      }),
    ).toBe('23505')
  })

  it('unlinked users coexist', async () => {
    expect(
      await sqlstate(async (c) => {
        await user(c, 'a@x.test')
        await user(c, 'b@x.test')
      }),
    ).toBeUndefined()
  })

  it('memberships deleted_at', async () => {
    const [col] = await q(
      `SELECT udt_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='memberships' AND column_name='deleted_at'`,
    )
    expect(col).toEqual({ udt_name: 'timestamptz', is_nullable: 'YES' })
  })

  it('old constraint gone', async () => {
    const rows = await q(`SELECT 1 FROM pg_constraint WHERE conname = 'memberships_organization_id_user_id_key'`)
    expect(rows).toEqual([])
  })

  it('live uniqueness', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const u = await user(c, 'a@x.test')
        const ins = `INSERT INTO memberships (organization_id, user_id, role, created_by) VALUES ($1, $2, 'owner', $2)`
        await c.query(ins, [o, u])
        await c.query(ins, [o, u])
      }),
    ).toBe('23505')
  })

  it('re-join after removal', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const u = await user(c, 'a@x.test')
        const ins = `INSERT INTO memberships (organization_id, user_id, role, created_by) VALUES ($1, $2, 'owner', $2)`
        await c.query(ins, [o, u])
        await c.query(`UPDATE memberships SET deleted_at = now() WHERE organization_id = $1 AND user_id = $2`, [o, u])
        await c.query(ins, [o, u])
      }),
    ).toBeUndefined()
  })

  it('indexes', async () => {
    const rows = await q<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='memberships'
       AND indexname IN ('idx_memberships_live_unique','idx_memberships_user_id')`,
    )
    const by = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
    expect(by['idx_memberships_live_unique']).toMatch(/CREATE UNIQUE INDEX/)
    expect(by['idx_memberships_live_unique']).toMatch(/WHERE \(?deleted_at IS NULL\)?/)
    expect(by['idx_memberships_user_id']).toMatch(/\(user_id\)/)
    expect(by['idx_memberships_user_id']).toMatch(/WHERE \(?deleted_at IS NULL\)?/)
  })
})
