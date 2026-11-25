import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '@vibase/storage-d1'
import { openLocalD1, type LocalD1 } from '@vibase/storage-d1/test'
import { seedDeployment, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { RESOURCES, type Resource } from '../test/extension-kit.js'
import { REF, applyGuarded } from '../test/guarded-kit.js'

// [[CORE565]] obligation 1: each guard the extension column DDL declares is enforced by D1, on the guarded fixture (a checked field, a NOT NULL DEFAULT field, a unique field, a reference). A guard that is declared but not enforced turns a case red.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-25T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['T'])
  d1 = local.bindings.T!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
  await applyGuarded(d1)
})
afterAll(() => local.dispose())

const all = async (sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
let n = 100
const put = (table: Resource, over: Record<string, unknown> = {}) => {
  const base: Record<string, unknown> = {
    id: id(++n),
    organization_id: ORG,
    created_by: USER,
    created_at: AT,
    updated_at: AT,
  }
  if (table === 'companies') base.name = `c${n}`
  if (table === 'tasks') base.title = `t${n}`
  if (table === 'deals') throw new Error('a deal needs a pipeline: not used here')
  const r = { ...base, ...over }
  const cols = Object.keys(r)
  return d1
    .prepare(
      `insert into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`,
    )
    .bind(...Object.values(r))
    .run()
}

describe('contacts: every declared guard is enforced by the database', () => {
  it('CHECK: a boolean column refuses 2, a text column refuses over 10,000 characters; 1 and a short text are stored', async () => {
    await expect(put('contacts', { flag__c: 2 })).rejects.toThrow(/CHECK constraint/i)
    await expect(put('contacts', { code__c: 'x'.repeat(10_001) })).rejects.toThrow(/CHECK constraint/i)
    await put('contacts', { flag__c: 1, code__c: 'short-check' })
  })
  it('NOT NULL: the required defaulted column refuses an explicit NULL and takes its default when the writer never names it', async () => {
    await expect(put('contacts', { lvl__c: null })).rejects.toThrow(/NOT NULL constraint/i)
    const row = id(n + 1)
    await put('contacts')
    expect((await all(`select lvl__c from contacts where id = ?`, row))[0]).toEqual({ lvl__c: 'std' })
  })
  it('unique index: two live rows with one value are refused; NULLs repeat; a tombstone holding the value is allowed, and so is a live row after it', async () => {
    await put('contacts', { code__c: 'dup' })
    await expect(put('contacts', { code__c: 'dup' })).rejects.toThrow(/UNIQUE constraint/i)
    await put('contacts')
    await put('contacts')
    await put('contacts', { code__c: 'tomb', deleted_at: AT })
    await put('contacts', { code__c: 'tomb' })
    await put('contacts', { code__c: 'tomb', deleted_at: AT })
  })
  it('foreign key: a reference to a missing company is refused; an existing one is stored, and survives the target being soft-deleted (D21)', async () => {
    await expect(put('contacts', { co__c: id(99) })).rejects.toThrow(/FOREIGN KEY constraint/i)
    const co = id(n + 1)
    await put('companies')
    await put('contacts', { co__c: co })
    await d1.prepare(`update companies set deleted_at = ? where id = ?`).bind(AT, co).run()
  })
})

describe('the other three built-ins carry the same guards (one DDL function writes all four)', () => {
  // The columns of the shared guards, as the table reports them (the reference column differs by name and target and is compared below).
  const defs = async (t: string) =>
    (
      await all(
        `select name, type, "notnull", dflt_value from pragma_table_info(?) where name in ('flag__c', 'lvl__c', 'code__c') order by name`,
        t,
      )
    ).map((c) => [c.name, c.type, c.notnull, c.dflt_value])
  const sqlOf = async (t: string) => (await all(`select sql from sqlite_schema where name = ?`, t))[0]!.sql as string
  const colSql = (sql: string, col: string) =>
    new RegExp(`"${col}" (?:TEXT|INTEGER).*?(?=, "[a-z0-9_]+" (?:TEXT|INTEGER)|\\) STRICT|$)`, 's').exec(sql)![0]
  const indexes = async (t: string) =>
    (
      await all(
        `select name, sql from sqlite_schema where type = 'index' and tbl_name = ? and name like '%\\_\\_c%' escape '\\' order by name`,
        t,
      )
    ).map((i) =>
      String(i.sql)
        .replaceAll(`"${t}"`, '"T"')
        .replaceAll(`_${t}_`, '_T_')
        .replaceAll(REF[t as Resource].column, 'ref__c'),
    )
  it.each(RESOURCES.filter((r) => r !== 'contacts'))(
    '%s: the same columns, CHECKs, defaults, unique index and foreign key as contacts',
    async (r) => {
      expect(await defs(r)).toEqual(await defs('contacts'))
      const mine = await sqlOf(r)
      const base = await sqlOf('contacts')
      for (const c of ['flag__c', 'lvl__c', 'code__c']) expect(colSql(mine, c), c).toBe(colSql(base, c))
      // The reference column differs by target only (contacts -> companies; the others -> contacts).
      expect(colSql(mine, REF[r].column)).toContain(`REFERENCES "${REF[r].target}" ("id")`)
      expect([...(await indexes(r))].sort()).toEqual([...(await indexes('contacts'))].sort())
    },
  )
  // deals is not run here (a deal row needs a pipeline and a stage); its columns, CHECKs, index and foreign key are compared with contacts' in the table-text case above.
  it.each(RESOURCES.filter((r) => r !== 'contacts' && r !== 'deals'))(
    '%s: the unique index and the foreign key refuse as on contacts',
    async (r) => {
      await put(r, { code__c: `${r}-dup` })
      await expect(put(r, { code__c: `${r}-dup` })).rejects.toThrow(/UNIQUE constraint/i)
      await expect(put(r, { [REF[r].column]: id(98) })).rejects.toThrow(/FOREIGN KEY constraint/i)
      await expect(put(r, { flag__c: 5 })).rejects.toThrow(/CHECK constraint/i)
      await expect(put(r, { lvl__c: null })).rejects.toThrow(/NOT NULL constraint/i)
    },
  )
})
