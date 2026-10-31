import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { clearD1, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CORE62 D1-D3, D10: the `associations` table, written as raw SQL around the operations. These are the backstop,
// not the plan: each constraint is proven by an insert the operations would never make.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-10-22T09:00:00.000Z'
const X = '0190b2c4-0000-7000-8000-0000000000aa'
const Y = '0190b2c4-0000-7000-8000-0000000000bb'

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'])
  d1 = local.bindings.D1!
})
afterAll(async () => {
  await local.dispose()
})
let n = 0
const id = () => `0190b2c4-0000-7000-8000-${String(++n).padStart(12, '0')}`
const edge = (over: Record<string, unknown> = {}) => ({
  id: id(), organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT,
  a_type: 'contacts', a_id: X, b_type: 'tasks', b_id: Y, relation: 'related_to', ...over,
})
const insertSql = (row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return `INSERT INTO "associations" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
}
const insert = async (row: Record<string, unknown>) => {
  await d1.prepare(insertSql(row)).bind(...Object.values(row)).run()
  return row.id as string
}
const refuse = async (row: Record<string, unknown>): Promise<string> => {
  try {
    await d1.batch([d1.prepare(insertSql(row)).bind(...Object.values(row))])
  } catch (err) {
    return String((err as Error).message)
  }
  throw new Error('expected the insert to be refused')
}

beforeEach(async () => {
  await clearD1(d1)
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
})

describe('associations table (CORE62, 0005)', () => {
  it('exists, STRICT, with the neighbours columns and nullability', async () => {
    const t = (await d1.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'associations'").first()) as { sql: string } | null
    expect(t?.sql).toMatch(/\) STRICT$/)
    const cols = (await d1.prepare('PRAGMA table_info(associations)').all()).results as Array<{ name: string; notnull: number }>
    expect(Object.fromEntries(cols.map((c) => [c.name, c.notnull === 1]))).toEqual({
      id: true, organization_id: true, a_type: true, a_id: true, b_type: true, b_id: true, relation: true,
      created_by: true, created_at: true, updated_at: true, deleted_at: false,
    })
  })

  it('has the live-pair unique index and the per-side lookup indexes, all partial on live rows', async () => {
    const idx = ((await d1.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'associations'").all()).results as Array<{ name: string; sql: string | null }>).filter((i) => i.sql)
    const by = Object.fromEntries(idx.map((i) => [i.name, i.sql!]))
    expect(Object.keys(by).sort()).toEqual(['idx_associations_a', 'idx_associations_b', 'idx_associations_live_unique'])
    for (const sql of Object.values(by)) expect(sql).toMatch(/WHERE deleted_at IS NULL/i)
    expect(by.idx_associations_live_unique).toMatch(/UNIQUE/i)
    for (const sql of Object.values(by)) expect(sql).toMatch(/\(organization_id, /)
  })

  it('stores a canonical row', async () => {
    await insert(edge())
  })

  it('a non-canonical row is refused (b before a)', async () => {
    expect(await refuse(edge({ a_type: 'tasks', a_id: Y, b_type: 'contacts', b_id: X }))).toContain('associations_canonical_order')
  })

  it('same type is ordered by id; the reverse is refused', async () => {
    await insert(edge({ a_type: 'contacts', a_id: X, b_type: 'contacts', b_id: Y }))
    expect(await refuse(edge({ a_type: 'contacts', a_id: Y, b_type: 'contacts', b_id: X }))).toContain('associations_canonical_order')
  })

  it('a self-pair is refused by the strict order', async () => {
    expect(await refuse(edge({ a_type: 'contacts', a_id: X, b_type: 'contacts', b_id: X }))).toContain('associations_canonical_order')
  })

  it('an uppercase or odd type is refused on either side', async () => {
    expect(await refuse(edge({ a_type: 'Contacts' }))).toMatch(/associations_a_type_identifier|CHECK/i)
    expect(await refuse(edge({ a_type: 'con tacts' }))).toContain('associations_a_type_identifier')
    expect(await refuse(edge({ b_type: 'Tasks' }))).toContain('associations_b_type_identifier')
    expect(await refuse(edge({ b_type: 'ta-sks' }))).toContain('associations_b_type_identifier')
    expect(await refuse(edge({ b_type: '' }))).toContain('associations_b_type_identifier')
  })

  it('an unknown relation is refused', async () => {
    expect(await refuse(edge({ relation: 'champion' }))).toContain('associations_relation')
  })

  it('a second live edge for the pair is refused; a soft delete frees it', async () => {
    const first = await insert(edge())
    expect(await refuse(edge())).toMatch(/UNIQUE/i)
    await d1.prepare('UPDATE associations SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(AT, AT, first).run()
    await insert(edge())
  })

  it('timestamps and ids are validated like the neighbours', async () => {
    expect(await refuse(edge({ created_at: 'yesterday' }))).toMatch(/CHECK|constraint/i)
    expect(await refuse(edge({ a_id: 'not-a-uuid' }))).toMatch(/CHECK|constraint/i)
    expect(await refuse(edge({ id: 'nope' }))).toMatch(/CHECK|constraint/i)
  })

  it('created_by must be a principal and the organisation must exist', async () => {
    expect(await refuse(edge({ created_by: id() }))).toMatch(/FOREIGN KEY/i)
    expect(await refuse(edge({ organization_id: id() }))).toMatch(/FOREIGN KEY/i)
  })
})
