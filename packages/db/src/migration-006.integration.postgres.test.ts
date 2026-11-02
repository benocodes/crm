import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

// CORE36 D2, D7: the application owns updated_at (no trigger, no function), and emails are lowercase ASCII on
// Postgres exactly as on D1. Raw pool on the owner connection; constraint checks run in rolled-back transactions.
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
const sqlstate = (fn: (c: pg.PoolClient) => Promise<unknown>): Promise<string | undefined> =>
  rolledBack(async (c) => {
    try {
      await fn(c)
      return undefined
    } catch (e) {
      return (e as { code?: string }).code
    }
  })

const org = async (c: pg.PoolClient) => (await c.query(`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)).rows[0].id as string
const principal = async (c: pg.PoolClient, kind = 'user') => (await c.query(`INSERT INTO principals (kind) VALUES ($1) RETURNING id`, [kind])).rows[0].id as string

describe('migration 006: the application owns updated_at', () => {
  it('no table has a set_updated_at trigger', async () => {
    expect(await q(`SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'set_updated_at'`)).toEqual([])
  })
  it('the trigger function is gone', async () => {
    expect((await q(`SELECT to_regprocedure('app.set_updated_at()') AS f`))[0]!.f).toBeNull()
  })
  it('an update leaves updated_at to the application', async () => {
    // Commits (the trigger used to replace updated_at with the transaction time); cleans up by its own ids.
    const c = await pool.connect()
    const ids: { org?: string; user?: string; task?: string } = {}
    try {
      ids.org = await org(c)
      ids.user = await principal(c)
      await c.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [ids.user, `stamp-${ids.user}@x.test`])
      ids.task = (
        await c.query(
          `INSERT INTO tasks (organization_id, title, created_by, created_at, updated_at) VALUES ($1, 't', $2, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z') RETURNING id`,
          [ids.org, ids.user],
        )
      ).rows[0].id
      await c.query(`UPDATE tasks SET title = 'u' WHERE id = $1`, [ids.task])
      const r = (await c.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS u FROM tasks WHERE id = $1`, [ids.task])).rows[0]
      expect(r.u).toBe('2020-01-01T00:00:00Z')
    } finally {
      if (ids.task) await c.query(`DELETE FROM tasks WHERE id = $1`, [ids.task])
      if (ids.user) {
        await c.query(`DELETE FROM users WHERE id = $1`, [ids.user])
        await c.query(`DELETE FROM principals WHERE id = $1`, [ids.user])
      }
      if (ids.org) await c.query(`DELETE FROM organizations WHERE id = $1`, [ids.org])
      c.release()
    }
  })
})

describe('migration 006: emails are lowercase ASCII (D7)', () => {
  const identity = (c: pg.PoolClient, o: string, p: string, kind: string, value: string) =>
    c.query(`INSERT INTO identities (organization_id, created_by, kind, value, own) VALUES ($1, $2, $3, $4, true)`, [o, p, kind, value])

  it('refuses an upper-case email identity', async () => {
    expect(await sqlstate(async (c) => identity(c, await org(c), await principal(c), 'email', 'Ori@x.com'))).toBe('23514')
  })
  it('refuses a non-ASCII email identity', async () => {
    expect(await sqlstate(async (c) => identity(c, await org(c), await principal(c), 'email', 'jürgen@x.com'))).toBe('23514')
  })
  it('accepts a lowercase ASCII email identity and leaves phone identities alone', async () => {
    expect(await sqlstate(async (c) => identity(c, await org(c), await principal(c), 'email', 'ori@x.com'))).toBeUndefined()
    expect(await sqlstate(async (c) => identity(c, await org(c), await principal(c), 'phone', '+14155550100'))).toBeUndefined()
  })
  it('refuses an upper-case user email even though the column is citext (the check casts to text)', async () => {
    expect(await sqlstate(async (c) => c.query(`INSERT INTO users (id, email) VALUES ($1, 'Ori@x.com')`, [await principal(c)]))).toBe('23514')
  })
  it('refuses a non-ASCII user email', async () => {
    expect(await sqlstate(async (c) => c.query(`INSERT INTO users (id, email) VALUES ($1, 'jürgen@x.com')`, [await principal(c)]))).toBe('23514')
  })
  it('accepts a lowercase ASCII user email', async () => {
    expect(await sqlstate(async (c) => c.query(`INSERT INTO users (id, email) VALUES ($1, 'ori@x.com')`, [await principal(c)]))).toBeUndefined()
  })
})
