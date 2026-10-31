import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb } from '@vault/db/test'
import { openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import type { D1Like } from '@vault/storage-d1'
import { createVaultRegistry } from '../operations.js'
import { CONTACT_NON_FK_REFERENCES, IDENTITY_REFERENCES } from './merge.js'

// CORE25 D35: every foreign key onto identities(id) is listed in IDENTITY_REFERENCES, on BOTH engines. Merge never
// changes identity ids, so the list has no re-point action; the guard makes a new FK onto identities a decision.
let owner: Kysely<Database>
let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  owner = createOwnerTestDb()
  local = await openLocalD1(['ICATALOG'])
  d1 = local.bindings.ICATALOG!
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
    WHERE c.contype = 'f' AND c.confrelid = 'identities'::regclass AND a.attname <> 'organization_id'`.execute(owner)
  return rows.map((r) => r.pair).sort()
}

async function d1Catalog(): Promise<string[]> {
  const tables = ((await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results as Array<{ name: string }>).map((t) => t.name)
  const out: string[] = []
  for (const t of tables) {
    const fks = (await d1.prepare(`SELECT "from" AS col FROM pragma_foreign_key_list('${t}') WHERE "table" = 'identities' AND "from" <> 'organization_id'`).all()).results as Array<{ col: string }>
    for (const f of fks) out.push(`${t}.${f.col}`)
  }
  return out.sort()
}

const listed = () => IDENTITY_REFERENCES.map((r) => `${r.table}.${r.column}`).sort()

describe('IDENTITY_REFERENCES catalog guard', () => {
  it('every foreign key onto identities is listed (Postgres)', async () => {
    expect(await postgresCatalog()).toEqual(listed())
  })
  it('every foreign key onto identities is listed (D1)', async () => {
    expect(await d1Catalog()).toEqual(listed())
  })
  it('guard: both catalogs see interaction_participants.identity_id', async () => {
    expect(await postgresCatalog()).toContain('interaction_participants.identity_id')
    expect(await d1Catalog()).toContain('interaction_participants.identity_id')
  })
  it('entries name real columns on both engines', async () => {
    for (const r of IDENTITY_REFERENCES) {
      const pg = (await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${r.table}`.execute(owner)).rows.map((x) => x.column_name)
      const lite = ((await d1.prepare(`SELECT name FROM pragma_table_info('${r.table}')`).all()).results as Array<{ name: string }>).map((x) => x.name)
      expect(pg).toContain(r.column)
      expect(lite).toContain(r.column)
    }
  })
})

// CORE62 D9/D16: associations are polymorphic (no FK), so they would escape the scan above. Identities are not associable
// (D9: addresses owned by a contact), which keeps them out of the polymorphic list; the list itself is guarded in merge-catalog.
describe('polymorphic references to identities (CORE62)', () => {
  it('identities are not an associable type, and the non-FK list is not empty', () => {
    const associable = createVaultRegistry().resources().filter((d) => d.associable).map((d) => d.table)
    expect(associable.length).toBeGreaterThan(0)
    expect(associable).not.toContain('identities')
    expect(CONTACT_NON_FK_REFERENCES.map((r) => r.table)).toContain('associations')
  })
})
