import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOwnerTestDb } from '@vibase/db/test'
import { COLUMN_KINDS } from '@vibase/storage'

// The portable StorageDatabase types are bound to the physical Postgres schema: every modelled table has at
// least the modelled columns; since CORE40 the second test requires them to be exactly the modelled columns.
// Columns that exist on D1 only (the portable inventory carries them, the Postgres schema does not): `events.seq` is D1's commit-order key ([[API105]] D16).
const D1_ONLY: Record<string, readonly string[]> = { events: ['seq'] }
const modelled = (table: string, kinds: Record<string, unknown>) => Object.keys(kinds).filter((c) => !(D1_ONLY[table] ?? []).includes(c))
const owner = createOwnerTestDb()
afterAll(() => owner.destroy())
beforeAll(async () => {
  await sql`select 1`.execute(owner)
})

describe('Postgres schema parity with the portable types', () => {
  it.each(Object.entries(COLUMN_KINDS))('%s has every modelled column', async (table, kinds) => {
    const { rows } = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`.execute(owner)
    const physical = rows.map((r) => r.column_name)
    for (const column of modelled(table, kinds)) expect(physical).toContain(column)
  })
  it('every modelled table is modelled exactly (no extra physical column the types do not know)', async () => {
    for (const table of Object.keys(COLUMN_KINDS) as Array<keyof typeof COLUMN_KINDS>) {
      const { rows } = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`.execute(owner)
      expect(rows.map((r) => r.column_name).sort()).toEqual(modelled(table, COLUMN_KINDS[table]).sort())
    }
  })
})
