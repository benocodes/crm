import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb } from '@vault/db/test'
import { openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import type { D1Like } from '@vault/storage-d1'
import { CONTACT_NON_FK_EXEMPTIONS, CONTACT_NON_FK_REFERENCES, CONTACT_REFERENCES, CONTACT_REFERENCE_EXEMPTIONS } from './merge.js'

// D8: the typed catalog plus its exemptions equals the foreign keys onto contacts, on BOTH engines.
let owner: Kysely<Database>
let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  owner = createOwnerTestDb()
  local = await openLocalD1(['CATALOG'])
  d1 = local.bindings.CATALOG!
})
afterAll(async () => {
  await owner.destroy()
  await local.dispose()
})

async function postgresCatalog(): Promise<string[]> {
  const { rows } = await sql<{ pair: string }>`
    SELECT c.conrelid::regclass::text || '.' || a.attname AS pair
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND c.confrelid = 'contacts'::regclass AND a.attname <> 'organization_id'`.execute(owner)
  return rows.map((r) => r.pair).sort()
}

async function d1Catalog(): Promise<string[]> {
  const tables = ((await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results as Array<{ name: string }>).map((t) => t.name)
  const out: string[] = []
  for (const t of tables) {
    const fks = (await d1.prepare(`SELECT "from" AS col FROM pragma_foreign_key_list('${t}') WHERE "table" = 'contacts' AND "from" <> 'organization_id'`).all()).results as Array<{ col: string }>
    for (const f of fks) out.push(`${t}.${f.col}`)
  }
  return out.sort()
}

const listed = () =>
  [...CONTACT_REFERENCES.map((r) => `${r.table}.${r.column}`), ...CONTACT_REFERENCE_EXEMPTIONS.map((r) => `${r.table}.${r.column}`)].sort()

describe('CONTACT_REFERENCES catalog guard', () => {
  it('every foreign key onto contacts is listed (Postgres)', async () => {
    expect(await postgresCatalog()).toEqual(listed())
  })
  it('every foreign key onto contacts is listed (D1)', async () => {
    expect(await d1Catalog()).toEqual(listed())
  })
  it('guard: both catalogs see something', async () => {
    for (const c of [await postgresCatalog(), await d1Catalog()]) {
      expect(c).toContain('identities.contact_id')
      expect(c).toContain('contacts.merged_into_id')
    }
  })
  it('entries name the definition table and real columns on both engines; liveOnly entries have deleted_at', async () => {
    for (const r of CONTACT_REFERENCES) {
      expect(r.def.table).toBe(r.table)
      const pg = (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${r.table}`.execute(owner)).rows.map((x) => x.column_name)
      const lite = ((await d1.prepare(`SELECT name FROM pragma_table_info('${r.table}')`).all()).results as Array<{ name: string }>).map((x) => x.name)
      for (const cols of [pg, lite]) {
        expect(cols).toContain(r.column)
        if (r.liveOnly) expect(cols).toContain('deleted_at')
      }
    }
  })
})

// CORE62 D16: a polymorphic reference (`<x>_type` beside `<x>_id`, no foreign key) is invisible to the FK scan above, so it
// is listed by hand and this guard finds every such pair on D1: a new one is a conscious merge decision.
async function d1PolymorphicReferences(): Promise<string[]> {
  const tables = ((await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results as Array<{ name: string }>).map((t) => t.name)
  const out: string[] = []
  for (const t of tables) {
    const cols = ((await d1.prepare(`SELECT name FROM pragma_table_info('${t}')`).all()).results as Array<{ name: string }>).map((c) => c.name)
    const fks = ((await d1.prepare(`SELECT "from" AS col FROM pragma_foreign_key_list('${t}')`).all()).results as Array<{ col: string }>).map((f) => f.col)
    for (const c of cols.filter((x) => x.endsWith('_type'))) {
      const id = `${c.slice(0, -'_type'.length)}_id`
      if (cols.includes(id) && !fks.includes(id)) out.push(`${t}.${id}`)
    }
  }
  return out.sort()
}

describe('CONTACT_NON_FK_REFERENCES catalog guard (CORE62 D16)', () => {
  it('every polymorphic reference is listed, with its type column', async () => {
    const listed = [...CONTACT_NON_FK_REFERENCES.flatMap((r) => r.columns.map((c) => `${r.table}.${c.id}`)), ...CONTACT_NON_FK_EXEMPTIONS.map((r) => `${r.table}.${r.column}`)].sort()
    expect(await d1PolymorphicReferences()).toEqual(listed)
  })
  it('guard: the scan sees associations on both sides (and the audit log resource_id, an exemption), and the entries name real columns', async () => {
    expect(await d1PolymorphicReferences()).toEqual(['associations.a_id', 'associations.b_id', 'events.resource_id'])
    for (const r of CONTACT_NON_FK_REFERENCES) {
      const lite = ((await d1.prepare(`SELECT name FROM pragma_table_info('${r.table}')`).all()).results as Array<{ name: string }>).map((x) => x.name)
      for (const c of r.columns) expect(lite).toEqual(expect.arrayContaining([c.id, c.type]))
    }
  })
})
