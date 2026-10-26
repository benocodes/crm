import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { clearD1, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const OTHER_ORG = '0190b2c4-0000-7000-8000-00000000a002'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'])
  d1 = local.bindings.D1!
})
afterAll(async () => {
  await local.dispose()
})
beforeEach(async () => {
  await clearD1(d1)
})

const all = async <T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> =>
  (await d1.prepare(sql).bind(...params).all()).results as T[]
const fails = async (sql: string, ...params: unknown[]): Promise<string> => {
  try {
    await d1.batch([d1.prepare(sql).bind(...params)])
  } catch (err) {
    return String((err as Error).message)
  }
  throw new Error(`expected a failure: ${sql}`)
}
const task = (over: Record<string, unknown> = {}) => ({
  id: '0190b2c4-0000-7000-8000-000000000101',
  organization_id: ORG,
  title: 't',
  status: 'open',
  created_by: USER,
  created_at: AT,
  updated_at: AT,
  ...over,
})
const insertTask = (row: Record<string, unknown>) =>
  fails(
    `INSERT INTO tasks (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`,
    ...Object.values(row),
  )
const insertTaskOk = async (row: Record<string, unknown>) => {
  await d1
    .prepare(`INSERT INTO tasks (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
    .bind(...Object.values(row))
    .run()
}

describe('the D1 schema slice of CORE35 (C6)', () => {
  it('creates the tables tasks and events need', async () => {
    const names = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['deployment', 'organizations', 'principals', 'users', 'events', 'tasks']))
  })

  it('has the task columns of the Postgres table, with the same nullability', async () => {
    const cols = await all<{ name: string; notnull: number }>('PRAGMA table_info(tasks)')
    const byName = Object.fromEntries(cols.map((c) => [c.name, c.notnull === 1]))
    expect(byName).toEqual({
      id: true,
      organization_id: true,
      title: true,
      notes: false,
      status: true,
      due_at: false,
      completed_at: false,
      assignee_id: false,
      created_by: true,
      created_at: true,
      updated_at: true,
      deleted_at: false,
    })
  })

  it('always enforces foreign keys', async () => {
    expect((await all<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]!.foreign_keys).toBe(1)
  })

  it('keeps the intra-database foreign keys of tasks and events', async () => {
    const fks = async (table: string) =>
      (await all<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${table})`)).map((f) => `${f.from}->${f.table}.${f.to}`).sort()
    expect(await fks('tasks')).toEqual(['assignee_id->principals.id', 'created_by->principals.id', 'organization_id->organizations.id'])
    expect(await fks('events')).toEqual(['actor_id->principals.id', 'organization_id->organizations.id'])
    expect(await fks('organizations')).toEqual(['id->deployment.organization_id'])
    expect(await fks('users')).toEqual(['id->principals.id'])
  })

  describe('the singleton deployment marker (D18)', () => {
    it('refuses a second marker row', async () => {
      await seedDeployment(d1, { organizationId: ORG })
      expect(await fails('INSERT INTO deployment (singleton, organization_id, auth_provider, auth_org_id) VALUES (2, ?, ?, ?)', OTHER_ORG, 'clerk', 'org_x')).toMatch(/CHECK|UNIQUE|constraint/i)
      expect(await fails('INSERT INTO deployment (singleton, organization_id, auth_provider, auth_org_id) VALUES (1, ?, ?, ?)', OTHER_ORG, 'clerk', 'org_x')).toMatch(/UNIQUE|PRIMARY|constraint/i)
    })

    it('refuses a second organisation: its id is a foreign key onto the marker', async () => {
      await seedDeployment(d1, { organizationId: ORG })
      expect(await fails('INSERT INTO organizations (id, created_at, updated_at, name) VALUES (?, ?, ?, ?)', OTHER_ORG, AT, AT, 'Other')).toMatch(/FOREIGN KEY/i)
    })

    it('refuses an organisation before any marker exists', async () => {
      expect(await fails('INSERT INTO organizations (id, created_at, updated_at, name) VALUES (?, ?, ?, ?)', ORG, AT, AT, 'Early')).toMatch(/FOREIGN KEY/i)
    })

    it('refuses a tenant row for a second organisation', async () => {
      await seedDeployment(d1, { organizationId: ORG })
      await seedPrincipal(d1, { id: USER, kind: 'user' })
      expect(await insertTask(task({ organization_id: OTHER_ORG }))).toMatch(/FOREIGN KEY/i)
      expect(
        await fails(
          'INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          '0190b2c4-0000-7000-8000-000000000201',
          AT,
          OTHER_ORG,
          'task.created',
          'task',
          '0190b2c4-0000-7000-8000-000000000101',
          USER,
        ),
      ).toMatch(/FOREIGN KEY/i)
    })
  })

  describe('checks', () => {
    beforeEach(async () => {
      await seedDeployment(d1, { organizationId: ORG })
      await seedPrincipal(d1, { id: USER, kind: 'user' })
    })

    it('accepts a valid task and reads it back as stored text', async () => {
      await insertTaskOk(task({ due_at: AT, notes: 'n' }))
      const rows = await all<Record<string, unknown>>('SELECT * FROM tasks')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ title: 't', status: 'open', due_at: AT, notes: 'n', completed_at: null, deleted_at: null })
    })

    it.each([
      ['status', { status: 'blocked' }],
      ['id shape', { id: 'NOT-A-UUID' }],
      ['uppercase id', { id: '0190B2C4-0000-7000-8000-000000000101' }],
      ['created_at shape', { created_at: '2026-10-22 09:00:00' }],
      ['due_at shape', { due_at: '2026-10-25' }],
      ['title not null', { title: null }],
      ['dangling assignee', { assignee_id: '0190b2c4-0000-7000-8000-00000000dead' }],
      ['dangling creator', { created_by: '0190b2c4-0000-7000-8000-00000000dead' }],
    ])('refuses a task with a bad %s', async (_name, over) => {
      expect(await insertTask(task(over))).toMatch(/CHECK|FOREIGN KEY|NOT NULL/i)
    })

    it('stores event JSON only when it is valid JSON', async () => {
      const insert = (before: string | null) =>
        fails(
          'INSERT INTO events (id, created_at, organization_id, type, resource_type, resource_id, actor_id, before) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          '0190b2c4-0000-7000-8000-000000000202',
          AT,
          ORG,
          'task.updated',
          'task',
          '0190b2c4-0000-7000-8000-000000000101',
          USER,
          before,
        )
      expect(await insert('{nope')).toMatch(/CHECK/i)
    })

    it('stores users with lowercase ASCII emails and 0/1 booleans, one principal each', async () => {
      const user = (over: Record<string, unknown>) => ({ id: USER, created_at: AT, updated_at: AT, email: 'a@example.com', ...over })
      const insertUser = (row: Record<string, unknown>) =>
        fails(`INSERT INTO users (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row))
      expect(await insertUser(user({ email: 'A@Example.com' }))).toMatch(/CHECK|UNIQUE/i)
      expect(await insertUser(user({ id: '0190b2c4-0000-7000-8000-00000000b009', email: 'ünï@example.com' }))).toMatch(/CHECK|FOREIGN KEY/i)
      expect(await insertUser(user({ id: '0190b2c4-0000-7000-8000-00000000b009', email_verified: 2 }))).toMatch(/CHECK|FOREIGN KEY/i)
    })

    it('allows at most one system principal', async () => {
      await seedPrincipal(d1, { id: '0190b2c4-0000-7000-8000-0000000000f1', kind: 'system' })
      expect(await fails('INSERT INTO principals (id, kind, created_at) VALUES (?, ?, ?)', '0190b2c4-0000-7000-8000-0000000000f2', 'system', AT)).toMatch(/UNIQUE/i)
    })
  })
})

describe('the identity model slice (CORE36 C3)', () => {
  const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
  const insertInto = (table: string, row: Record<string, unknown>) =>
    fails(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row))
  const insertOk = async (table: string, row: Record<string, unknown>) => {
    await d1
      .prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
      .bind(...Object.values(row))
      .run()
  }
  const base = (n: number, over: Record<string, unknown> = {}) => ({ id: id(n), organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT, ...over })
  const company = (n: number, over: Record<string, unknown> = {}) => base(n, { name: 'Acme', ...over })
  const contact = (n: number, over: Record<string, unknown> = {}) => base(n, over)
  const identity = (n: number, over: Record<string, unknown> = {}) => base(n, { kind: 'email', value: 'a@example.com', contact_id: id(500), own: 0, ...over })

  beforeEach(async () => {
    await seedDeployment(d1, { organizationId: ORG })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
  })

  it('creates the tables', async () => {
    const names = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['companies', 'contacts', 'identities', 'unit_assertion']))
  })

  it('has the columns and nullability of the Postgres tables', async () => {
    const shape = async (table: string) =>
      Object.fromEntries((await all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`)).map((c) => [c.name, c.notnull === 1]))
    const common = { id: true, created_at: true, updated_at: true, organization_id: true, created_by: true, deleted_at: false }
    expect(await shape('companies')).toEqual({ ...common, name: true, domain: false })
    expect(await shape('contacts')).toEqual({ ...common, name: false, company_id: false, merged_into_id: false })
    expect(await shape('identities')).toEqual({ ...common, kind: true, value: true, contact_id: false, own: true })
  })

  it('keeps the foreign keys, composite and plain', async () => {
    const fks = async (table: string) =>
      (await all<{ id: number; seq: number; table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${table})`))
        .sort((a, b) => a.id - b.id || a.seq - b.seq)
        .reduce<Record<number, string[]>>((acc, f) => ((acc[f.id] ??= []).push(`${f.from}->${f.table}.${f.to}`), acc), {})
    const flat = async (table: string) =>
      Object.values(await fks(table)).map((g) => g.join('+')).sort()
    expect(await flat('companies')).toEqual(['created_by->principals.id', 'organization_id->organizations.id'])
    expect(await flat('contacts')).toEqual([
      'created_by->principals.id',
      'organization_id->contacts.organization_id+merged_into_id->contacts.id',
      'organization_id->companies.organization_id+company_id->companies.id',
      'organization_id->organizations.id',
    ].sort())
    expect(await flat('identities')).toEqual([
      'created_by->principals.id',
      'organization_id->contacts.organization_id+contact_id->contacts.id',
      'organization_id->organizations.id',
    ].sort())
  })

  it('allows one live company per domain, and a domain again after a soft delete', async () => {
    await insertOk('companies', company(1, { domain: 'acme.com' }))
    expect(await insertInto('companies', company(2, { domain: 'acme.com' }))).toMatch(/UNIQUE/i)
    await insertOk('companies', company(3, { domain: null }))
    await insertOk('companies', company(4, { domain: null }))
    await d1.prepare('UPDATE companies SET deleted_at = ? WHERE id = ?').bind(AT, id(1)).run()
    await insertOk('companies', company(5, { domain: 'acme.com' }))
  })

  it('allows one live identity per address, and the address again after a soft delete', async () => {
    await insertOk('contacts', contact(500))
    await insertOk('identities', identity(1))
    expect(await insertInto('identities', identity(2))).toMatch(/UNIQUE/i)
    await d1.prepare('UPDATE identities SET deleted_at = ? WHERE id = ?').bind(AT, id(1)).run()
    await insertOk('identities', identity(3))
  })

  it('enforces the owner rule own = (contact_id IS NULL)', async () => {
    await insertOk('contacts', contact(500))
    expect(await insertInto('identities', identity(1, { own: 1 }))).toMatch(/CHECK/i)
    expect(await insertInto('identities', identity(2, { contact_id: null, own: 0 }))).toMatch(/CHECK/i)
    await insertOk('identities', identity(3, { contact_id: null, own: 1, value: 'me@example.com' }))
    expect(await insertInto('identities', identity(4, { own: 2 }))).toMatch(/CHECK/i)
    expect(await insertInto('identities', identity(5, { kind: 'sms', value: 'x' }))).toMatch(/CHECK/i)
  })

  it('enforces the tombstone checks on merged_into_id', async () => {
    await insertOk('contacts', contact(500))
    expect(await insertInto('contacts', contact(501, { merged_into_id: id(500) }))).toMatch(/CHECK/i)
    expect(await insertInto('contacts', contact(502, { merged_into_id: id(502), deleted_at: AT }))).toMatch(/CHECK/i)
    await insertOk('contacts', contact(503, { merged_into_id: id(500), deleted_at: AT }))
  })

  it('stores email identities lowercase ASCII only, and leaves phones alone', async () => {
    await insertOk('contacts', contact(500))
    expect(await insertInto('identities', identity(1, { value: 'A@Example.com' }))).toMatch(/CHECK/i)
    expect(await insertInto('identities', identity(2, { value: 'jürgen@example.com' }))).toMatch(/CHECK/i)
    await insertOk('identities', identity(3, { kind: 'phone', value: '+14155550100' }))
  })

  it('refuses a reference that does not exist in this organisation (foreign key)', async () => {
    expect(await insertInto('contacts', contact(500, { company_id: id(999) }))).toMatch(/FOREIGN KEY/i)
    expect(await insertInto('identities', identity(1, { contact_id: id(999) }))).toMatch(/FOREIGN KEY/i)
    expect(await insertInto('companies', company(2, { organization_id: OTHER_ORG }))).toMatch(/FOREIGN KEY/i)
  })

  it('unit_assertion never holds a row: a true condition inserts nothing, a false one aborts with the named constraint', async () => {
    await d1.batch([d1.prepare('INSERT INTO unit_assertion (ok) SELECT 0 WHERE NOT (1 = 1)')])
    expect(await fails('INSERT INTO unit_assertion (ok) SELECT 0 WHERE NOT (1 = 0)')).toContain('unit_assertion_holds')
    expect((await all<{ n: number }>('SELECT count(*) AS n FROM unit_assertion'))[0]!.n).toBe(0)
  })
})

describe('the administration slice (CORE40 C2)', () => {
  const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
  const AGENT = id(601)
  const insertInto = (table: string, row: Record<string, unknown>) =>
    fails(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row))
  const insertOk = async (table: string, row: Record<string, unknown>) => {
    await d1
      .prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
      .bind(...Object.values(row))
      .run()
  }
  const base = (n: number, over: Record<string, unknown> = {}) => ({ id: id(n), organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT, ...over })
  const membership = (n: number, userId: string, over: Record<string, unknown> = {}) => base(n, { user_id: userId, role: 'member', ...over })
  const agent = (n: number, over: Record<string, unknown> = {}) => base(n, { name: 'a', ...over })
  const key = (n: number, over: Record<string, unknown> = {}) => base(n, { agent_id: AGENT, key_hash: `hash-${n}`, prefix: 'vk_xxxxxxxx', ...over })
  const count = async (table: string) => (await all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n

  beforeEach(async () => {
    await seedDeployment(d1, { organizationId: ORG })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await seedPrincipal(d1, { id: AGENT, kind: 'agent' })
  })

  it('creates the tables', async () => {
    const names = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['memberships', 'agents', 'api_keys']))
  })

  it('has the columns and nullability of the Postgres tables', async () => {
    const shape = async (table: string) =>
      Object.fromEntries((await all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`)).map((c) => [c.name, c.notnull === 1]))
    const common = { id: true, created_at: true, updated_at: true, organization_id: true, created_by: true }
    expect(await shape('memberships')).toEqual({ ...common, user_id: true, role: true, deleted_at: false })
    expect(await shape('agents')).toEqual({ ...common, name: true, scopes: true, disabled_at: false })
    expect(await shape('api_keys')).toEqual({ ...common, agent_id: true, key_hash: true, prefix: true, last_used_at: false, revoked_at: false, expires_at: false })
  })

  it('keeps the plain foreign keys, all cascading where Postgres cascades', async () => {
    const fks = async (table: string) =>
      (await all<{ table: string; from: string; to: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`)).map((f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`).sort()
    expect(await fks('memberships')).toEqual(['created_by->principals.id:NO ACTION', 'organization_id->organizations.id:CASCADE', 'user_id->users.id:CASCADE'])
    expect(await fks('agents')).toEqual(['created_by->principals.id:NO ACTION', 'id->principals.id:CASCADE', 'organization_id->organizations.id:CASCADE'])
    expect(await fks('api_keys')).toEqual(['agent_id->agents.id:CASCADE', 'created_by->principals.id:NO ACTION', 'organization_id->organizations.id:CASCADE'])
  })

  it('allows one live membership per user, and another after the first is soft-deleted', async () => {
    await insertOk('memberships', membership(1, USER))
    expect(await insertInto('memberships', membership(2, USER))).toMatch(/UNIQUE/i)
    await d1.prepare('UPDATE memberships SET deleted_at = ? WHERE id = ?').bind(AT, id(1)).run()
    await insertOk('memberships', membership(3, USER))
  })

  it('checks the membership role', async () => {
    expect(await insertInto('memberships', membership(1, USER, { role: 'admin' }))).toMatch(/CHECK/i)
    await insertOk('memberships', membership(2, USER, { role: 'owner' }))
  })

  it('stores agent scopes only as a JSON array', async () => {
    expect(await insertInto('agents', agent(1, { id: AGENT, scopes: 'x' }))).toMatch(/CHECK/i)
    expect(await insertInto('agents', agent(1, { id: AGENT, scopes: '{}' }))).toMatch(/CHECK/i)
    await insertOk('agents', agent(1, { id: AGENT, scopes: '["tasks:read"]' }))
    await d1.prepare("UPDATE agents SET scopes = '[]' WHERE id = ?").bind(AGENT).run()
    expect(((await all<{ scopes: string }>('SELECT scopes FROM agents'))[0]!).scopes).toBe('[]')
  })

  it('defaults agent scopes to an empty array', async () => {
    await insertOk('agents', agent(1, { id: AGENT }))
    expect((await all<{ scopes: string }>('SELECT scopes FROM agents'))[0]!.scopes).toBe('[]')
  })

  it('keeps key hashes unique', async () => {
    await insertOk('agents', agent(1, { id: AGENT }))
    await insertOk('api_keys', key(2, { key_hash: 'same' }))
    expect(await insertInto('api_keys', key(3, { key_hash: 'same' }))).toMatch(/UNIQUE/i)
  })

  it('checks the shape of the optional timestamps', async () => {
    await insertOk('agents', agent(1, { id: AGENT }))
    await seedPrincipal(d1, { id: id(602), kind: 'agent' })
    expect(await insertInto('agents', agent(9, { id: id(602), disabled_at: '2026-10-22' }))).toMatch(/CHECK/i)
    expect(await insertInto('api_keys', key(2, { revoked_at: 'yesterday' }))).toMatch(/CHECK/i)
    expect(await insertInto('api_keys', key(3, { expires_at: '2026-10-22 09:00:00' }))).toMatch(/CHECK/i)
    expect(await insertInto('api_keys', key(4, { last_used_at: '2026' }))).toMatch(/CHECK/i)
    await insertOk('api_keys', key(5, { revoked_at: AT, expires_at: AT, last_used_at: AT }))
  })

  it('refuses a key for an agent that does not exist, and a membership for a user that does not exist', async () => {
    expect(await insertInto('api_keys', key(1, { agent_id: id(699) }))).toMatch(/FOREIGN KEY/i)
    expect(await insertInto('memberships', membership(2, id(698)))).toMatch(/FOREIGN KEY/i)
  })

  it('deleting a principal removes its agent row and that agent\'s keys', async () => {
    await insertOk('agents', agent(1, { id: AGENT }))
    await insertOk('api_keys', key(2))
    await d1.prepare('DELETE FROM principals WHERE id = ?').bind(AGENT).run()
    expect(await count('agents')).toBe(0)
    expect(await count('api_keys')).toBe(0)
  })
})
