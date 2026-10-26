import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLUMN_KINDS } from '@vault/storage'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// The portable StorageDatabase types are bound to the physical schema: every modelled table has exactly the
// modelled columns (every table in COLUMN_KINDS is physical on D1 since CORE40's 0003).
let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['PARITY'])
  d1 = local.bindings.PARITY!
})
afterAll(() => local.dispose())

describe('D1 schema parity with the portable types', () => {
  it.each(Object.entries(COLUMN_KINDS))('%s has exactly the modelled columns', async (table, kinds) => {
    const cols = ((await d1.prepare(`pragma table_info(${table})`).all()).results as Array<{ name: string }>).map((c) => c.name)
    expect(cols.sort()).toEqual(Object.keys(kinds).sort())
  })
})
