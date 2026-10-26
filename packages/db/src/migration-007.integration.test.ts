import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

// Migration 007 ([[CORE40]] P3, C3): the prepared runtime stamps `updated_at` itself (CORE36 D2), so the tenant
// role may update that one more column of agents and api_keys. Nothing else is widened.

let pool: pg.Pool
beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
})
afterAll(() => pool.end())

const colPriv = async (table: string, col: string): Promise<boolean> =>
  (await pool.query<{ p: boolean }>(`SELECT has_column_privilege('vault_authenticated', $1, $2, 'UPDATE') AS p`, [table, col])).rows[0]!.p

describe('migration 007 admin app-clock grants', () => {
  it('agents: updated_at is updatable by the tenant role', async () => {
    expect(await colPriv('agents', 'updated_at')).toBe(true)
  })

  it('api_keys: updated_at is updatable by the tenant role', async () => {
    expect(await colPriv('api_keys', 'updated_at')).toBe(true)
  })

  it('widens nothing else', async () => {
    for (const col of ['key_hash', 'prefix', 'last_used_at', 'id', 'organization_id', 'agent_id', 'created_by', 'created_at', 'expires_at']) {
      expect(await colPriv('api_keys', col), `api_keys.${col}`).toBe(false)
    }
    for (const col of ['id', 'organization_id', 'created_by', 'created_at']) expect(await colPriv('agents', col), `agents.${col}`).toBe(false)
    // The grants that existed before still hold.
    expect(await colPriv('api_keys', 'revoked_at')).toBe(true)
    for (const col of ['name', 'scopes', 'disabled_at']) expect(await colPriv('agents', col), `agents.${col}`).toBe(true)
  })

  it('a tenant stamps updated_at on an agent and on an api key (no 42501)', async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('SET LOCAL ROLE vault_service')
      const org = (await c.query(`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)).rows[0].id as string
      const owner = (await c.query(`INSERT INTO principals (kind) VALUES ('user') RETURNING id`)).rows[0].id as string
      const agent = (await c.query(`INSERT INTO principals (kind) VALUES ('agent') RETURNING id`)).rows[0].id as string
      await c.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [owner, `u-${owner}@example.test`])
      await c.query(`INSERT INTO memberships (organization_id, user_id, role, created_by) VALUES ($1, $2, 'owner', $2)`, [org, owner])
      await c.query(`INSERT INTO agents (id, organization_id, name, created_by) VALUES ($1, $2, 'a', $3)`, [agent, org, owner])
      const key = (await c.query(`INSERT INTO api_keys (organization_id, agent_id, key_hash, prefix, created_by) VALUES ($1, $2, $3, 'vk_xxxxxxxx', $4) RETURNING id`, [org, agent, 'h'.repeat(64), owner])).rows[0].id as string
      await c.query(`SELECT set_config('app.organization_id', $1, true), set_config('app.principal_id', $2, true)`, [org, owner])
      await c.query('SET LOCAL ROLE vault_authenticated')
      await c.query(`UPDATE agents SET name = 'n', updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [agent])
      await c.query(`UPDATE api_keys SET revoked_at = '2020-01-01T00:00:00Z', updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [key])
      const row = (await c.query(`SELECT to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD') AS d FROM agents WHERE id = $1`, [agent])).rows[0]
      expect(row.d).toBe('2020-01-01')
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
})
