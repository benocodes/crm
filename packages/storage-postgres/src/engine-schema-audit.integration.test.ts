import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOwnerTestDb } from '@vault/db/test'
import { COLUMN_KINDS } from '@vault/storage'
import { openLocalD1, type LocalD1 } from '@vault/storage-d1/test'
import { ENGINE_DIFFERENCES, NOT_COMPARED, d1Shape, diffShapes, postgresShape, type EngineDifference, type SchemaShape } from './test/schema-audit.js'

// Spec CORE38 D10: the physical constraints of the two engines are bound to each other, and every difference is
// named. Only the enterprise side may import both engines (invariant 10), hence this file lives here.
//
// Not compared (stated, not hidden):
//   see NOT_COMPARED in ./test/schema-audit.ts
void NOT_COMPARED

const owner = createOwnerTestDb()
let local: LocalD1
let pg: SchemaShape
let d1: SchemaShape
let d1Sql: Map<string, string>
const tables = Object.keys(COLUMN_KINDS)

beforeAll(async () => {
  local = await openLocalD1(['AUDIT'])
  const db = local.bindings.AUDIT!
  pg = await postgresShape(owner, tables)
  d1 = await d1Shape(db, tables)
  const { results } = await db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all()
  d1Sql = new Map((results ?? []).map((r) => [(r as { name: string }).name, (r as { sql: string }).sql]))
})
afterAll(async () => {
  await owner.destroy()
  await local.dispose()
})

const strip = (list: readonly EngineDifference[]) =>
  list
    .map(({ aspect, engine, table, item }) => ({ aspect, engine, table, item }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('engine schema audit (Postgres vs D1)', () => {
  it('guard: both shapes are non-trivial', () => {
    expect(pg.tables.length).toBeGreaterThanOrEqual(11)
    expect(d1.tables.length).toBeGreaterThanOrEqual(11)
    expect(pg.byTable.tasks!.foreignKeys).toHaveLength(3)
    expect(d1.byTable.tasks!.foreignKeys).toHaveLength(3)
  })

  it('every difference is listed (no unlisted, no stale entry)', () => {
    expect(strip(diffShapes(pg, d1))).toEqual(strip(ENGINE_DIFFERENCES))
  })

  it('every listed difference has a reason', () => {
    for (const d of ENGINE_DIFFERENCES) expect(d.reason, `${d.aspect} ${d.table} ${d.item}`).not.toBe('')
  })

  it('unnamed D1 checks are still there', () => {
    const entries = ENGINE_DIFFERENCES.filter((d) => d.aspect === 'namedCheck' && d.engine === 'postgres')
    expect(entries.length).toBeGreaterThan(0)
    for (const d of entries) {
      expect(d.d1Fragment, `${d.table} ${d.item} needs a d1Fragment`).toBeTruthy()
      expect(collapse(d1Sql.get(d.table) ?? ''), `${d.table}: ${d.d1Fragment}`).toContain(collapse(d.d1Fragment!))
    }
  })

  it('composite intra-organisation keys match', () => {
    for (const t of ['contacts', 'identities']) expect(d1.byTable[t]!.foreignKeys).toEqual(pg.byTable[t]!.foreignKeys)
    expect(d1.byTable.contacts!.foreignKeys).toContain('(organization_id, company_id) -> companies(organization_id, id) on delete no action')
    expect(d1.byTable.contacts!.foreignKeys).toContain('(organization_id, merged_into_id) -> contacts(organization_id, id) on delete no action')
    expect(d1.byTable.identities!.foreignKeys).toContain('(organization_id, contact_id) -> contacts(organization_id, id) on delete no action')
  })
})
