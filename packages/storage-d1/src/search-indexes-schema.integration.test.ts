import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, clearD1, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CORE194 cycle 1 (D4, D5, D6, D14): the three single-table FTS5 trigram indexes (migration 0014), their triggers and population,
// proven at SQL level. Nothing in the API reads them yet.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'
const DEL = '2026-10-23T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const MIGRATION = '0014_search_indexes.sql'

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1', 'OLD'], { migrate: false })
  d1 = local.bindings.D1!
  await applyMigrations(d1)
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
})
afterAll(async () => {
  await local.dispose()
})

const all = async (db: D1Like, text: string, ...binds: unknown[]) => ((await db.prepare(text).bind(...binds).all()).results ?? []) as Record<string, any>[]
const run = (db: D1Like, text: string, ...binds: unknown[]) => db.prepare(text).bind(...binds).run()

// The three resources: table, indexed columns, an insert helper, and an UPDATE that changes each indexed column.
interface Spec {
  table: 'companies' | 'notes' | 'tasks'
  cols: [string, string]
  insert: (db: D1Like, n: number, a: string | null, b: string | null, deleted?: string | null) => Promise<unknown>
}
const SPECS: Spec[] = [
  {
    table: 'companies',
    cols: ['name', 'domain'],
    insert: (db, n, a, b, deleted = null) =>
      run(db, 'INSERT INTO companies (id, organization_id, created_by, created_at, updated_at, name, domain, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id(n), ORG, USER, AT, AT, a, b, deleted),
  },
  {
    table: 'notes',
    cols: ['title', 'content'],
    insert: (db, n, a, b, deleted = null) =>
      run(db, 'INSERT INTO notes (id, organization_id, created_by, created_at, updated_at, title, content, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id(n), ORG, USER, AT, AT, a, b, deleted),
  },
  {
    table: 'tasks',
    cols: ['title', 'notes'],
    insert: (db, n, a, b, deleted = null) =>
      run(db, 'INSERT INTO tasks (id, organization_id, created_by, created_at, updated_at, title, notes, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id(n), ORG, USER, AT, AT, a, b, deleted),
  },
]

/** The D4 predicate shape, joined to the base table, with the caller's own FTS5 quoting. */
const matchIds = async (db: D1Like, table: string, expr: string) =>
  (await all(db, `SELECT b.id AS id FROM "${table}" AS b WHERE b.deleted_at IS NULL AND b.id IN (SELECT id FROM "${table}_search" WHERE "${table}_search" MATCH ?) ORDER BY b.id`, expr)).map((r) => r.id as string)
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`
const indexIds = async (db: D1Like, table: string) => (await all(db, `SELECT id FROM "${table}_search" ORDER BY id`)).map((r) => r.id as string)

describe('migration 0014 over a database at 0013 with data', () => {
  it('indexes exactly the live rows of each resource, NULL fields included, and keeps the rows', async () => {
    const old = local.bindings.OLD!
    const before = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0014')) cpSync(join(MIGRATIONS_DIR, f), join(before, f))
    expect(readdirSync(before).sort().pop()).toBe('0013_send_connection.sql')
    await applyMigrations(old, before)
    await seedDeployment(old, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(old, { id: USER, kind: 'user' })
    for (const s of SPECS) {
      await s.insert(old, 1, 'Alpha one', s.table === 'notes' ? 'body one' : 'x.example')
      await s.insert(old, 2, 'Beta two', s.table === 'notes' ? 'body two' : null) // NULL domain / tasks.notes (notes.content is NOT NULL)
      await s.insert(old, 3, 'Gone three', s.table === 'notes' ? 'body three' : 'gone.example', DEL) // soft-deleted
    }
    await run(old, 'INSERT INTO notes (id, organization_id, created_by, created_at, updated_at, title, content) VALUES (?, ?, ?, ?, ?, NULL, ?)', id(4), ORG, USER, AT, AT, 'untitled note') // NULL title
    expect((await all(old, "SELECT name FROM sqlite_master WHERE name LIKE '%_search'"))).toEqual([])

    const only = mkdtempSync(join(tmpdir(), 'mig14-'))
    cpSync(join(MIGRATIONS_DIR, MIGRATION), join(only, MIGRATION))
    expect(await applyMigrations(old, only)).toEqual([MIGRATION])

    expect(await indexIds(old, 'companies')).toEqual([id(1), id(2)])
    expect(await indexIds(old, 'notes')).toEqual([id(1), id(2), id(4)])
    expect(await indexIds(old, 'tasks')).toEqual([id(1), id(2)])
    expect(await matchIds(old, 'companies', quote('x.example'))).toEqual([id(1)])
    expect(await matchIds(old, 'companies', quote('gone.example'))).toEqual([])
    expect(await matchIds(old, 'notes', quote('untitled'))).toEqual([id(4)])
    // the existing rows are untouched
    expect((await all(old, 'SELECT count(*) AS n FROM companies')).map((r) => r.n)).toEqual([3])
    // a NULL field is stored as NULL, not as text
    expect((await all(old, "SELECT title FROM notes_search WHERE id = ?", id(4))).map((r) => r.title)).toEqual([null])
  })

  it('creates empty indexes on an empty database', async () => {
    const fresh = await openLocalD1(['E'])
    try {
      const db = fresh.bindings.E!
      for (const t of ['companies', 'notes', 'tasks']) expect(await indexIds(db, t)).toEqual([])
      const tables = (await all(db, "SELECT name FROM sqlite_master WHERE name IN ('companies_search','notes_search','tasks_search') ORDER BY name")).map((r) => r.name)
      expect(tables).toEqual(['companies_search', 'notes_search', 'tasks_search'])
    } finally {
      await fresh.dispose()
    }
  })

  it('declares the tables as standalone FTS5 with the trigram tokenizer and no organization_id', async () => {
    for (const t of ['companies', 'notes', 'tasks']) {
      const [row] = await all(d1, 'SELECT sql FROM sqlite_master WHERE name = ?', `${t}_search`)
      expect(row?.sql).toMatch(/USING fts5/i)
      expect(row?.sql).toMatch(/tokenize\s*=\s*'trigram'/i)
      expect(row?.sql).not.toMatch(/organization_id|content\s*=/i)
      expect(row?.sql).toMatch(/id UNINDEXED/i)
    }
  })
})

describe.each(SPECS)('the $table index is kept by triggers (D5 matrix)', (spec) => {
  const [a, b] = spec.cols
  const N = 10
  const setA = (value: string | null) => run(d1, `UPDATE "${spec.table}" SET "${a}" = ? WHERE id = ?`, value, id(N))
  const setB = (value: string | null) => run(d1, `UPDATE "${spec.table}" SET "${b}" = ? WHERE id = ?`, value, id(N))
  const found = (term: string) => matchIds(d1, spec.table, quote(term))

  beforeAll(async () => {
    await clearD1(d1)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
  })

  it('insert live: found by either column; insert already soft-deleted: not indexed', async () => {
    await spec.insert(d1, N, 'Quokka title', 'wombat text')
    expect(await found('quokka')).toEqual([id(N)])
    expect(await found('wombat')).toEqual([id(N)])
    await spec.insert(d1, N + 1, 'Deleted dingo', 'deleted dingo text', DEL)
    expect(await found('dingo')).toEqual([])
    expect(await indexIds(d1, spec.table)).toEqual([id(N)])
  })

  it('update of each indexed field: the old text is gone, the new is found', async () => {
    await setA('Platypus title')
    expect(await found('quokka')).toEqual([])
    expect(await found('platypus')).toEqual([id(N)])
    await setB('numbat text')
    expect(await found('wombat')).toEqual([])
    expect(await found('numbat')).toEqual([id(N)])
    expect(await indexIds(d1, spec.table)).toEqual([id(N)]) // still one entry, never a duplicate
  })

  it('soft delete removes the entry; clearing deleted_at brings it back', async () => {
    await run(d1, `UPDATE "${spec.table}" SET deleted_at = ? WHERE id = ?`, DEL, id(N))
    expect(await indexIds(d1, spec.table)).toEqual([])
    expect(await found('platypus')).toEqual([])
    await run(d1, `UPDATE "${spec.table}" SET deleted_at = NULL WHERE id = ?`, id(N))
    expect(await found('platypus')).toEqual([id(N)])
    expect(await indexIds(d1, spec.table)).toEqual([id(N)])
  })

  it('a field set to NULL stops matching on its old text and stays findable by the other field', async () => {
    if (spec.table === 'notes') {
      await setA(null) // notes.title is nullable; content is NOT NULL
      expect(await found('platypus')).toEqual([])
      expect(await found('numbat')).toEqual([id(N)])
    } else {
      await setB(null)
      expect(await found('numbat')).toEqual([])
      expect(await found('platypus')).toEqual([id(N)])
    }
  })

  it('hard delete removes the entry', async () => {
    await run(d1, `DELETE FROM "${spec.table}" WHERE id = ?`, id(N))
    expect(await indexIds(d1, spec.table)).toEqual([])
    // and the index has no orphan after the other row too
    await run(d1, `DELETE FROM "${spec.table}" WHERE id = ?`, id(N + 1))
    expect(await indexIds(d1, spec.table)).toEqual([])
  })
})

describe('match semantics at SQL level (D4 predicate shape)', () => {
  beforeAll(async () => {
    await clearD1(d1)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await SPECS[0]!.insert(d1, 1, 'Acme Renewals Ltd', 'acme-renewals.example')
    await SPECS[0]!.insert(d1, 2, 'Other "quoted" * OR name: -dash', null)
    await SPECS[1]!.insert(d1, 1, 'Quarterly review', 'The RENEWAL conversation')
  })

  it('finds a case-insensitive substring inside a word, in either indexed column', async () => {
    expect(await matchIds(d1, 'companies', quote('newal'))).toEqual([id(1)]) // inside "Renewals" (name) and the domain
    expect(await matchIds(d1, 'companies', quote('ACME'))).toEqual([id(1)])
    expect(await matchIds(d1, 'companies', quote('.example'))).toEqual([id(1)]) // domain column only
    expect(await matchIds(d1, 'notes', quote('renewal'))).toEqual([id(1)]) // content, case folded
    expect(await matchIds(d1, 'notes', quote('arterly'))).toEqual([id(1)]) // title
  })

  it('treats a bound FTS5-quoted string with " * - OR : literally and never errors', async () => {
    expect(await matchIds(d1, 'companies', quote('"quoted"'))).toEqual([id(2)])
    expect(await matchIds(d1, 'companies', quote('d" * OR'))).toEqual([id(2)])
    expect(await matchIds(d1, 'companies', quote('name: -dash'))).toEqual([id(2)])
    for (const hostile of ['*', 'OR', '-dash', 'name:', 'a" OR "b', '(', 'NEAR(', '^x']) {
      await expect(matchIds(d1, 'companies', quote(hostile))).resolves.toBeDefined()
    }
    expect(await matchIds(d1, 'companies', quote('* OR'))).toEqual([id(2)]) // the operator word and the star, as literal text
  })
})

describe('write cost (D5, D14): the index is rewritten only when an indexed column or deleted_at changes', () => {
  // The index is looked up by its UNINDEXED id column, so removing an entry reads the whole index (rows_read grows with the table).
  // An update that cannot change the indexed text (a timestamp, a status) must not pay that.
  const readsOf = async (text: string, ...binds: unknown[]) => ((await d1.prepare(text).bind(...binds).all()) as { meta: { rows_read: number } }).meta.rows_read

  beforeAll(async () => {
    await clearD1(d1)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    for (let i = 0; i < 200; i += 100) {
      await d1.batch(
        Array.from({ length: 100 }, (_, j) =>
          d1.prepare('INSERT INTO tasks (id, organization_id, created_by, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?, ?)').bind(id(500 + i + j), ORG, USER, AT, AT, `Task number ${i + j}`),
        ),
      )
    }
  })

  it('a status or timestamp update does not scan the index; a title update does (that scan is the stated cost)', async () => {
    expect(await readsOf('UPDATE tasks SET updated_at = ?, status = ? WHERE id = ?', DEL, 'done', id(550))).toBeLessThan(20)
    expect(await readsOf('UPDATE tasks SET title = ? WHERE id = ?', 'Renamed task', id(551))).toBeGreaterThanOrEqual(200)
    expect(await matchIds(d1, 'tasks', quote('renamed'))).toEqual([id(551)])
  })
})
