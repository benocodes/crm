import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONVENTION_EXEMPTIONS, checkConventions, openLocalD1, readCatalogue, type LocalD1 } from './test/index.js'

// [[CORE679]] D1: the schema conventions (C1-C8) hold over the live catalogue of the CRM database after the migrations ran. The
// checker is proven rule by rule in `test/conventions.test.ts`; this test is what keeps the schema one design, for every
// later migration ([[CORE680]]'s renames among them). The control database joins in [[CORE683]].
let local: LocalD1
beforeAll(async () => {
  local = await openLocalD1(['CRM'])
})
afterAll(() => local.dispose())

describe('the CRM database follows the schema conventions', () => {
  it('has no problem under C1-C8, with every exemption naming a live column', async () => {
    const problems = checkConventions(await readCatalogue(local.bindings.CRM!), CONVENTION_EXEMPTIONS, 'crm')
    expect(problems.map((p) => `${p.rule} ${p.object}: ${p.message}`)).toEqual([])
  })
})
