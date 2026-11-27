import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import {
  canonicalLength,
  normaliseExpr,
  openLocalD1,
  parseChecks,
  readCatalogue,
  type LocalD1,
} from '@vibase/storage-d1/test'
import type { BuiltInDeclaration } from './builtin.js'
import { companiesDeclaration } from './companies.js'
import { contactsDeclaration } from './contacts.js'
import { dealsDeclaration } from './deals.js'
import { tasksDeclaration } from './tasks.js'

// [[CORE683]] D6, C4 (planner rule P1, row 683.2): the built-in declarations' text limits are database limits, in both directions, on a
// database built from genesis. Every text field with a `maxLength` carries a CHECK named `<table>_<column>_length` of exactly the
// canonical text its bounds and nullability give, and every `_length` CHECK of the four tables names a declared field with a
// `maxLength`. Extension (`__c`) columns are outside it (their CHECK takes `TEXT_MAX` from the extension and is held by the conventions test).
const DECLARATIONS: BuiltInDeclaration[] = [
  contactsDeclaration,
  companiesDeclaration,
  dealsDeclaration,
  tasksDeclaration,
]

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['LENDECL'])
  d1 = local.bindings.LENDECL!
})
afterAll(() => local.dispose())

const liveLengthChecks = async (table: string) => {
  const t = (await readCatalogue(d1)).tables.find((x) => x.name === table)!
  return parseChecks(
    t.sql,
    t.columns.map((c) => c.name),
  ).filter((c) => c.name?.endsWith('_length'))
}

describe('declared limits are database limits (C4)', () => {
  for (const decl of DECLARATIONS)
    describe(decl.table, () => {
      const declared = Object.entries(decl.fields).filter(([, f]) => f.kind === 'text' && f.maxLength !== undefined)

      it('every declared maxLength is the live CHECK, with its minLength and nullability', async () => {
        const live = new Map((await liveLengthChecks(decl.table)).map((c) => [c.name, c.expr]))
        for (const [column, f] of declared)
          expect(live.get(`${decl.table}_${column}_length`), `${decl.table}.${column}`).toBe(
            normaliseExpr(canonicalLength(column, f.maxLength!, f.minLength, f.nullable === true)),
          )
      })

      it('every live _length CHECK names a declared field with a maxLength', async () => {
        const names = (await liveLengthChecks(decl.table)).map((c) => c.name).sort()
        expect(names).toEqual(declared.map(([column]) => `${decl.table}_${column}_length`).sort())
      })
    })

  it('covers the six declared limits the cycle names (a declaration losing its maxLength cannot empty this test)', () => {
    const all = DECLARATIONS.flatMap((d) =>
      Object.entries(d.fields)
        .filter(([, f]) => f.kind === 'text' && f.maxLength !== undefined)
        .map(([c]) => `${d.table}.${c}`),
    )
    expect(all.sort()).toEqual(
      ['companies.domain', 'companies.name', 'contacts.name', 'deals.name', 'tasks.description', 'tasks.title'].sort(),
    )
  })
})
