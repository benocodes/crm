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

type World = { orgA: string; orgB: string; userA: string; userB: string }
async function world(c: pg.PoolClient): Promise<World> {
  const org = async () => (await c.query(`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)).rows[0].id as string
  const user = async (organizationId: string) => {
    const id = (await c.query(`INSERT INTO principals (kind) VALUES ('user') RETURNING id`)).rows[0].id as string
    await c.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`])
    return id
  }
  const orgA = await org()
  const orgB = await org()
  return { orgA, orgB, userA: await user(orgA), userB: await user(orgB) }
}
const company = async (c: pg.PoolClient, org: string, user: string, name = 'C', domain: string | null = null) =>
  (await c.query(`INSERT INTO companies (organization_id, created_by, name, domain) VALUES ($1,$2,$3,$4) RETURNING id`, [org, user, name, domain])).rows[0].id as string
const contact = async (c: pg.PoolClient, org: string, user: string, extra: { company_id?: string | null } = {}) =>
  (await c.query(`INSERT INTO contacts (organization_id, created_by, company_id) VALUES ($1,$2,$3) RETURNING id`, [org, user, extra.company_id ?? null])).rows[0].id as string
const identity = async (c: pg.PoolClient, org: string, user: string, v: { kind?: string; value?: string; contact_id?: string | null; own?: boolean; deleted?: boolean }) =>
  (await c.query(
    `INSERT INTO identities (organization_id, created_by, kind, value, contact_id, own, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [org, user, v.kind ?? 'email', v.value ?? 'a@b.com', v.contact_id ?? null, v.own ?? false, v.deleted ? new Date() : null],
  )).rows[0].id as string

const TABLES = ['companies', 'contacts', 'identities']

type Col = [string, string, boolean, boolean]
const base: Col[] = [
  ['id', 'uuid', false, true],
  ['created_at', 'timestamptz', false, true],
  ['updated_at', 'timestamptz', false, true],
  ['organization_id', 'uuid', false, false],
  ['created_by', 'uuid', false, false],
  ['deleted_at', 'timestamptz', true, false],
]
const SHAPES: Record<string, Col[]> = {
  companies: [...base, ['name', 'text', false, false], ['domain', 'citext', true, false]],
  contacts: [...base, ['name', 'text', true, false], ['company_id', 'uuid', true, false], ['merged_into_id', 'uuid', true, false]],
  identities: [
    ...base,
    ['kind', 'text', false, false],
    ['value', 'text', false, false],
    ['contact_id', 'uuid', true, false],
    ['own', 'bool', false, true],
  ],
}

describe('migration 003 identity model', () => {
  for (const table of TABLES) {
    it(`columns: ${table}`, async () => {
      const rows = await q<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table],
      )
      const actual = rows.map((r) => [r.column_name, r.udt_name, r.is_nullable === 'YES', r.column_default !== null] as Col).sort((a, b) => a[0].localeCompare(b[0]))
      expect(actual).toEqual([...SHAPES[table]!].sort((a, b) => a[0].localeCompare(b[0])))
    })
  }

  it('own defaults to false', async () => {
    const [r] = await q(`SELECT column_default FROM information_schema.columns WHERE table_name='identities' AND column_name='own'`)
    expect(r.column_default).toBe('false')
  })

  it('constraints and indexes by name', async () => {
    const cons = (await q<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid IN ('companies'::regclass,'contacts'::regclass,'identities'::regclass)`)).map((r) => r.conname)
    for (const n of [
      'idx_companies_organization_id_id_unique', 'idx_contacts_organization_id_id_unique', 'idx_identities_organization_id_id_unique',
      'contacts_company_fk', 'contacts_merged_into_fk', 'contacts_merged_is_deleted', 'contacts_not_merged_into_self',
      'identities_kind', 'identities_contact_fk', 'identities_own_xor_contact',
    ]) expect(cons).toContain(n)
    const idx = await q<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'`)
    const byName = Object.fromEntries(idx.map((i) => [i.indexname, i.indexdef]))
    for (const n of ['idx_companies_domain_unique', 'idx_identities_address_unique']) {
      expect(byName[n], n).toBeDefined()
      expect(byName[n]).toContain('deleted_at IS NULL')
      expect(byName[n]).toContain('UNIQUE')
    }
    for (const n of ['idx_contacts_organization_id_company_id', 'idx_identities_contact_id']) expect(byName[n], n).toBeDefined()
  })

  it('identities is a composite FK target', async () => {
    const rows = await q<{ cols: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'identities'::regclass AND c.contype = 'u' GROUP BY c.oid`,
    )
    expect(rows.map((r) => r.cols)).toContainEqual(['organization_id', 'id'])
  })

  it('kind check', async () => {
    expect(await sqlstate(async (c) => { const w = await world(c); await identity(c, w.orgA, w.userA, { kind: 'fax' }) })).toBe('23514')
  })

  it('own xor contact', async () => {
    expect(await sqlstate(async (c) => { const w = await world(c); const k = await contact(c, w.orgA, w.userA); await identity(c, w.orgA, w.userA, { own: true, contact_id: k }) })).toBe('23514')
    expect(await sqlstate(async (c) => { const w = await world(c); await identity(c, w.orgA, w.userA, { own: false }) })).toBe('23514')
  })

  it('live address unique', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const k = await contact(c, w.orgA, w.userA)
      await identity(c, w.orgA, w.userA, { contact_id: k }); await identity(c, w.orgA, w.userA, { contact_id: k })
    })).toBe('23505')
  })

  it('address reusable after soft delete', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const k = await contact(c, w.orgA, w.userA)
      await identity(c, w.orgA, w.userA, { contact_id: k, deleted: true }); await identity(c, w.orgA, w.userA, { contact_id: k })
    })).toBeUndefined()
  })

  it('same address in two orgs', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c)
      await identity(c, w.orgA, w.userA, { own: true }); await identity(c, w.orgB, w.userB, { own: true })
    })).toBeUndefined()
  })

  it('company domain unique and case-insensitive', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c)
      await company(c, w.orgA, w.userA, 'a', 'Acme.com'); await company(c, w.orgA, w.userA, 'b', 'acme.COM')
    })).toBe('23505')
  })

  it('null domains repeat', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c)
      await company(c, w.orgA, w.userA); await company(c, w.orgA, w.userA)
    })).toBeUndefined()
  })

  it('cross-tenant company refused by the FK', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const co = await company(c, w.orgB, w.userB)
      await contact(c, w.orgA, w.userA, { company_id: co })
    })).toBe('23503')
  })

  it('cross-tenant contact refused by the FK', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const k = await contact(c, w.orgB, w.userB)
      await identity(c, w.orgA, w.userA, { contact_id: k })
    })).toBe('23503')
  })

  it('cross-tenant merged_into_id refused', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const other = await contact(c, w.orgB, w.userB)
      await c.query(`INSERT INTO contacts (organization_id, created_by, merged_into_id, deleted_at) VALUES ($1,$2,$3,now())`, [w.orgA, w.userA, other])
    })).toBe('23503')
  })

  it('merged must be deleted', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const a = await contact(c, w.orgA, w.userA); const b = await contact(c, w.orgA, w.userA)
      await c.query(`UPDATE contacts SET merged_into_id = $1 WHERE id = $2`, [a, b])
    })).toBe('23514')
  })

  it('not merged into self', async () => {
    expect(await sqlstate(async (c) => {
      const w = await world(c); const a = await contact(c, w.orgA, w.userA)
      await c.query(`UPDATE contacts SET merged_into_id = id, deleted_at = now() WHERE id = $1`, [a])
    })).toBe('23514')
  })

  it('grants', async () => {
    for (const role of ['vault_authenticated', 'vault_service']) {
      for (const t of TABLES) {
        const rows = await q<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_name=$2 AND table_schema='public'`,
          [role, t],
        )
        expect(rows.map((r) => r.privilege_type).sort(), `${role} ${t}`).toEqual(['INSERT', 'SELECT', 'UPDATE'])
      }
    }
  })

  it('policies', async () => {
    const rows = await q<{ tablename: string; policyname: string; cmd: string; roles: string[] }>(
      `SELECT tablename, policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = ANY($1)`,
      [TABLES],
    )
    expect(rows.map((r) => [r.tablename, r.policyname, r.cmd, r.roles]).sort()).toEqual(
      TABLES.map((t) => [t, `${t}_tenant`, 'ALL', ['vault_authenticated']]).sort(),
    )
  })

  it('RLS forced', async () => {
    const rows = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'`,
      [TABLES],
    )
    expect(rows).toHaveLength(3)
    for (const r of rows) expect([r.relrowsecurity, r.relforcerowsecurity]).toEqual([true, true])
  })
})
