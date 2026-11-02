import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

let pool: pg.Pool
let appPool: pg.Pool

beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
  appPool = new pg.Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2 })
})
afterAll(async () => {
  await pool.end()
  await appPool.end()
})

async function grants(grantee: string, table: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2 ORDER BY privilege_type`,
    [grantee, table],
  )
  return rows.map((r) => r.privilege_type)
}

describe('migration 002: vault_service grants', () => {
  it.each(['organizations', 'principals', 'users', 'memberships', 'agents', 'api_keys', 'tasks'])(
    '%s: INSERT, SELECT, UPDATE only',
    async (t) => {
      expect(await grants('vault_service', t)).toEqual(['INSERT', 'SELECT', 'UPDATE'])
    },
  )

  it('events: append-only for the service role', async () => {
    expect(await grants('vault_service', 'events')).toEqual(['INSERT', 'SELECT'])
  })

  it('nothing on the Kysely tables', async () => {
    expect(await grants('vault_service', 'kysely_migration')).toEqual([])
    expect(await grants('vault_service', 'kysely_migration_lock')).toEqual([])
  })

  it('vault_authenticated grants are unchanged', async () => {
    for (const t of ['organizations', 'users']) {
      expect(await grants('vault_authenticated', t), t).toEqual(['SELECT'])
    }
    expect(await grants('vault_authenticated', 'events')).toEqual(['INSERT', 'SELECT'])
    expect(await grants('vault_authenticated', 'tasks')).toEqual(['INSERT', 'SELECT', 'UPDATE'])
  })

  it('behaviour: vault_service cannot read kysely_migration but can read tasks', async () => {
    const c = await appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query('SET LOCAL ROLE vault_service')
      await expect(c.query('SELECT count(*) FROM tasks')).resolves.toBeDefined()
      await expect(c.query('SELECT count(*) FROM kysely_migration')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
})
