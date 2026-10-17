import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { createOwnerTestDb } from '@vault/db/test'
import { CONTACT_REFERENCES, CONTACT_REFERENCE_EXEMPTIONS } from './merge.js'

let owner: Kysely<Database>
beforeAll(() => {
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await owner.destroy()
})

async function catalog(): Promise<string[]> {
  const { rows } = await sql<{ pair: string }>`
    SELECT c.conrelid::regclass::text || '.' || a.attname AS pair
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND c.confrelid = 'contacts'::regclass AND a.attname <> 'organization_id'`.execute(owner)
  return rows.map((r) => r.pair).sort()
}

describe('CONTACT_REFERENCES catalog guard', () => {
  it('every FK to contacts is listed', async () => {
    const listed = [
      ...CONTACT_REFERENCES.map((r) => `${r.def.table}.${r.column}`),
      ...CONTACT_REFERENCE_EXEMPTIONS.map((r) => `${r.table}.${r.column}`),
    ].sort()
    expect(await catalog()).toEqual(listed)
  })
  it('guard: the catalog sees something', async () => {
    const c = await catalog()
    expect(c).toContain('identities.contact_id')
    expect(c).toContain('contacts.merged_into_id')
  })
  it('entries name real columns', async () => {
    for (const r of CONTACT_REFERENCES) {
      const { rows } = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${r.def.table}`.execute(owner)
      const cols = rows.map((x) => x.column_name)
      expect(cols).toContain(r.column)
      if (r.liveOnly) expect(cols).toContain('deleted_at')
    }
  })
})
