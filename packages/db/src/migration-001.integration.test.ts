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

/** The SQLSTATE of the error `fn` throws inside its own savepoint-free, rolled-back transaction. */
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

const TABLES = ['organizations', 'principals', 'users', 'memberships', 'agents', 'api_keys', 'events', 'tasks']

// [column, udt_name, nullable, has default]
type Col = [string, string, boolean, boolean]
const ID: Col = ['id', 'uuid', false, true]
const ID_NO_DEFAULT: Col = ['id', 'uuid', false, false]
const CREATED: Col = ['created_at', 'timestamptz', false, true]
const UPDATED: Col = ['updated_at', 'timestamptz', false, true]
const ORG: Col = ['organization_id', 'uuid', false, false]

const SHAPES: Record<string, Col[]> = {
  organizations: [ID, CREATED, UPDATED, ['name', 'text', false, false]],
  principals: [ID, CREATED, ['kind', 'text', false, false]],
  agents: [
    ID_NO_DEFAULT, CREATED, UPDATED, ORG,
    ['name', 'text', false, false],
    ['scopes', '_text', false, true],
    ['disabled_at', 'timestamptz', true, false],
    ['created_by', 'uuid', false, false],
  ],
  api_keys: [
    ID, CREATED, UPDATED, ORG,
    ['agent_id', 'uuid', false, false],
    ['key_hash', 'text', false, false],
    ['prefix', 'text', false, false],
    ['last_used_at', 'timestamptz', true, false],
    ['revoked_at', 'timestamptz', true, false],
    ['expires_at', 'timestamptz', true, false],
    ['created_by', 'uuid', false, false],
  ],
  events: [
    ID, CREATED, ORG,
    ['type', 'text', false, false],
    ['resource_type', 'text', false, false],
    ['resource_id', 'uuid', false, false],
    ['actor_id', 'uuid', false, false],
    ['before', 'jsonb', true, false],
    ['after', 'jsonb', true, false],
  ],
  tasks: [
    ID, CREATED, UPDATED, ORG,
    ['title', 'text', false, false],
    ['notes', 'text', true, false],
    ['status', 'text', false, true],
    ['due_at', 'timestamptz', true, false],
    ['completed_at', 'timestamptz', true, false],
    ['assignee_id', 'uuid', true, false],
    ['created_by', 'uuid', false, false],
    ['deleted_at', 'timestamptz', true, false],
  ],
}

describe('migration 001 baseline', () => {
  it('tables exist', async () => {
    const rows = await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES, 'companies', 'contacts', 'identities', 'kysely_migration', 'kysely_migration_lock'].sort())
  })

  for (const table of TABLES.filter((t) => t in SHAPES)) {
    it(`column shapes: ${table}`, async () => {
      const rows = await q<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
      const actual = rows
        .map((r) => [r.column_name, r.udt_name, r.is_nullable === 'YES', r.column_default !== null] as Col)
        .sort((a, b) => a[0].localeCompare(b[0]))
      const expected = [...SHAPES[table]!].sort((a, b) => a[0].localeCompare(b[0]))
      expect(actual).toEqual(expected)
    })
  }

  it('principal-backed ids', async () => {
    for (const table of ['users', 'agents']) {
      const [col] = await q(
        `SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`,
        [table],
      )
      expect(col.column_default).toBeNull()
      const fks = await q<{ ref: string; confdeltype: string }>(
        `SELECT confrelid::regclass::text AS ref, confdeltype FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'id')]`,
        [table],
      )
      expect(fks).toEqual([{ ref: 'principals', confdeltype: 'c' }])
    }
  })

  it('uuidv7', async () => {
    const id = await rolledBack(async (c) => {
      const r = await c.query(`INSERT INTO organizations (name) VALUES ('x') RETURNING id`)
      return r.rows[0].id as string
    })
    expect(id[14]).toBe('7')
  })

  async function org(c: pg.PoolClient): Promise<string> {
    return (await c.query(`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)).rows[0].id
  }
  async function user(c: pg.PoolClient, email: string): Promise<string> {
    const id = (await c.query(`INSERT INTO principals (kind) VALUES ('user') RETURNING id`)).rows[0].id
    await c.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, email])
    return id
  }

  it('status check', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const u = await user(c, 'a@x.test')
        await c.query(`INSERT INTO tasks (organization_id, title, status, created_by) VALUES ($1, 't', 'archived', $2)`, [o, u])
      }),
    ).toBe('23514')
  })

  it('kind check', async () => {
    expect(await sqlstate((c) => c.query(`INSERT INTO principals (kind) VALUES ('bot')`))).toBe('23514')
  })

  it('email is case-insensitive unique', async () => {
    expect(
      await sqlstate(async (c) => {
        await user(c, 'A@x.test')
        await user(c, 'a@x.test')
      }),
    ).toBe('23505')
  })

  it('membership unique', async () => {
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

  it('key hash unique', async () => {
    expect(
      await sqlstate(async (c) => {
        const o = await org(c)
        const u = await user(c, 'a@x.test')
        const a = (await c.query(`INSERT INTO principals (kind) VALUES ('agent') RETURNING id`)).rows[0].id
        await c.query(`INSERT INTO agents (id, organization_id, name, created_by) VALUES ($1, $2, 'a', $3)`, [a, o, u])
        const ins = `INSERT INTO api_keys (organization_id, agent_id, key_hash, prefix, created_by) VALUES ($1, $2, 'h', 'p', $3)`
        await c.query(ins, [o, a, u])
        await c.query(ins, [o, a, u])
      }),
    ).toBe('23505')
  })

  it('updated_at trigger', async () => {
    // now() is the transaction's start time, so the insert and the update must be separate
    // transactions; this one test commits and cleans up after itself.
    const c = await pool.connect()
    try {
      const o = await org(c)
      const u = await user(c, 'trigger@x.test')
      const t = (
        await c.query(`INSERT INTO tasks (organization_id, title, created_by) VALUES ($1, 't', $2) RETURNING id`, [o, u])
      ).rows[0].id
      await c.query(`SELECT pg_sleep(0.01)`)
      await c.query(`UPDATE tasks SET title = 'u' WHERE id = $1`, [t])
      const r = (await c.query(`SELECT updated_at > created_at AS later FROM tasks WHERE id = $1`, [t])).rows[0]
      expect(r.later).toBe(true)
    } finally {
      await c.query(`TRUNCATE tasks, memberships, users, principals, organizations CASCADE`)
      c.release()
    }
  })

  it('no trigger on append-only', async () => {
    const rows = await q(
      `SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('events'::regclass, 'principals'::regclass)`,
    )
    expect(rows).toEqual([])
  })

  it('functions', async () => {
    const [r] = await q(`SELECT app.current_organization_id() AS o, app.current_principal_id() AS p`)
    expect(r).toEqual({ o: null, p: null })
  })

  it('roles', async () => {
    const rows = await q(
      `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'vault\\_%' ORDER BY rolname`,
    )
    expect(rows).toEqual([
      { rolname: 'vault_app', rolcanlogin: true, rolinherit: false, rolsuper: false, rolbypassrls: false },
      { rolname: 'vault_authenticated', rolcanlogin: false, rolinherit: true, rolsuper: false, rolbypassrls: false },
      { rolname: 'vault_service', rolcanlogin: false, rolinherit: true, rolsuper: false, rolbypassrls: true },
    ])
  })

  it('membership of vault_app', async () => {
    const rows = await q<{ rolname: string }>(
      `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
       WHERE r.rolname = 'vault_app' ORDER BY g.rolname`,
    )
    expect(rows.map((r) => r.rolname)).toEqual(['vault_authenticated', 'vault_service'])
  })

  it('indexes', async () => {
    const rows = await q<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('events', 'tasks')`,
    )
    const names = rows.map((r) => r.indexname)
    expect(names).toContain('idx_events_organization_id_id')
    expect(names).toContain('idx_tasks_organization_id_id')
  })
})
