import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOwnerTestDb } from '@vault/db/test'
import { COLUMN_KINDS } from '@vault/storage'

// The portable StorageDatabase types are bound to the physical Postgres schema: every modelled table has at
// least the modelled columns (Postgres tables carry more, e.g. organizations.auth_*, which later cycles model).
const owner = createOwnerTestDb()
afterAll(() => owner.destroy())
beforeAll(async () => {
  await sql`select 1`.execute(owner)
})

describe('Postgres schema parity with the portable types', () => {
  it.each(Object.entries(COLUMN_KINDS))('%s has every modelled column', async (table, kinds) => {
    const { rows } = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`.execute(owner)
    const physical = rows.map((r) => r.column_name)
    for (const column of Object.keys(kinds)) expect(physical).toContain(column)
  })
  it('tasks and events are modelled exactly (no extra physical column the types do not know)', async () => {
    for (const table of ['tasks', 'events'] as const) {
      const { rows } = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`.execute(owner)
      expect(rows.map((r) => r.column_name).sort()).toEqual(Object.keys(COLUMN_KINDS[table]).sort())
    }
  })
})
