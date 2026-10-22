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
      id: false, // a TEXT primary key reports notnull 0 in SQLite; the PRIMARY KEY makes it unique, the CHECK makes it a UUID
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
