import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE683]] D6 (matrix: column x case): the built-in declarations' text limits are database limits. For each column a raw insert
// at the bound passes, one over is refused (by the CHECK's name), an empty value is refused where the declaration has `minLength: 1`,
// and NULL passes where the column is nullable. Raw inserts are the permitted exception: this proves what the database refuses,
// which no operation reaches (the API's own validation is proven elsewhere). The declaration side is `@vibase/api`'s
// `declarations/length-checks.integration.d1.test.ts`.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-27T09:00:00.000Z'
const PIPELINE = '0190b2c4-0000-7000-8000-000000000010'
const STAGE = '0190b2c4-0000-7000-8000-000000000020'
let n = 100
const next = () => `0190b2c4-0000-7000-8000-${String(n++).padStart(12, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['LEN'])
  d1 = local.bindings.LEN!
  await seedDeployment(d1, { organizationId: ORG })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
  const base = { organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT }
  expect(await insert('pipelines', { id: PIPELINE, name: 'Sales', ...base })).toBeNull()
  expect(
    await insert('pipeline_stages', {
      id: STAGE,
      pipeline_id: PIPELINE,
      name: 'Open',
      kind: 'open',
      position: 1,
      ...base,
    }),
  ).toBeNull()
})
afterAll(() => local.dispose())

const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return d1
    .batch([
      d1
        .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...Object.values(row)),
    ])
    .then(
      () => null,
      (e: Error) => e.message,
    )
}
const common = { organization_id: ORG, created_by: USER, created_at: AT, updated_at: AT }
// One valid row per table, the column under test replaced; `domain` gets a distinct value per row (live domains are unique).
const row = (table: string, column: string, value: unknown): Record<string, unknown> => {
  switch (table) {
    case 'contacts':
      return { id: next(), ...common, [column]: value }
    case 'companies':
      return { id: next(), ...common, name: 'Acme', ...(column === 'domain' ? {} : { domain: null }), [column]: value }
    case 'tasks':
      return { id: next(), ...common, title: 'Call', [column]: value }
    case 'deals':
      return { id: next(), ...common, name: 'Deal', pipeline_id: PIPELINE, stage_id: STAGE, [column]: value }
    default:
      throw new Error(table)
  }
}

interface Spec {
  table: string
  column: string
  min?: number
  max: number
  nullable: boolean
}
// The declarations' bounds ([[CORE554]]): minLength 1 on the required names and titles, none on domain and notes.
const SPECS: Spec[] = [
  { table: 'contacts', column: 'name', min: 1, max: 500, nullable: true },
  { table: 'companies', column: 'name', min: 1, max: 500, nullable: false },
  { table: 'companies', column: 'domain', max: 253, nullable: true },
  { table: 'tasks', column: 'title', min: 1, max: 500, nullable: false },
  { table: 'tasks', column: 'description', max: 10_000, nullable: true },
  { table: 'deals', column: 'name', min: 1, max: 200, nullable: false },
]

describe.each(SPECS)('$table.$column length CHECK', ({ table, column, min, max, nullable }) => {
  const name = `${table}_${column}_length`
  const val = (len: number) =>
    column === 'domain' ? `${'a'.repeat(Math.max(len - 4, 0))}.com`.slice(0, len) : 'x'.repeat(len)

  it('passes at the upper bound', async () => {
    expect(await insert(table, row(table, column, val(max)))).toBeNull()
  })
  it('refuses one over the upper bound, by name', async () => {
    expect((await insert(table, row(table, column, val(max + 1)))) ?? 'accepted').toContain(name)
  })
  if (min !== undefined)
    it('passes at the lower bound and refuses an empty string, by name', async () => {
      expect(await insert(table, row(table, column, val(min)))).toBeNull()
      expect((await insert(table, row(table, column, ''))) ?? 'accepted').toContain(name)
    })
  else
    it('has no lower bound: an empty string passes', async () => {
      expect(await insert(table, row(table, column, ''))).toBeNull()
    })
  it(nullable ? 'passes NULL' : 'refuses NULL (NOT NULL, not the length CHECK)', async () => {
    const r = await insert(table, row(table, column, null))
    if (nullable) expect(r).toBeNull()
    else expect(r ?? 'accepted').toMatch(/NOT NULL/)
  })
})
