import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import { withServiceRole, type Database } from '@vault/db'
import { createOwnerTestDb, createTestDb, truncateAll } from '@vault/db/test'
import { systemPrincipalId } from './system-principal.js'

let db: Kysely<Database>
let owner: Kysely<Database>

beforeAll(() => {
  db = createTestDb({ max: 2 })
  owner = createOwnerTestDb()
})
afterAll(async () => {
  await db.destroy()
  await owner.destroy()
})
beforeEach(() => truncateAll(owner))

const systemRows = () => owner.selectFrom('principals').selectAll().where('kind', '=', 'system').execute()

describe('systemPrincipalId', () => {
  it('is created once and found again', async () => {
    const first = await withServiceRole(db, systemPrincipalId)
    const second = await withServiceRole(db, systemPrincipalId)
    expect(second).toBe(first)
    const rows = await systemRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(first)
  })

  it('concurrent first use creates one row', async () => {
    const [a, b] = await Promise.all([withServiceRole(db, systemPrincipalId), withServiceRole(db, systemPrincipalId)])
    expect(a).toBe(b)
    expect(await systemRows()).toHaveLength(1)
  })

  it('has no user or agent row', async () => {
    const id = await withServiceRole(db, systemPrincipalId)
    expect(await owner.selectFrom('users').select('id').where('id', '=', id).execute()).toEqual([])
    expect(await owner.selectFrom('agents').select('id').where('id', '=', id).execute()).toEqual([])
  })
})
