import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE318]] D1 (cycle 1): migration 0026 adds `additional_props TEXT NOT NULL DEFAULT '{}'` with a json-object CHECK to contacts, companies,
// deals and tasks. Seeded at 0025 with a row in each table; raw inserts are the permitted exception (the test proves what the database
// does, which no operation reaches).
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AT = '2026-11-24T09:00:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const PIPE = id(10)
const STAGE = id(11)
const TABLES = ['contacts', 'companies', 'deals', 'tasks'] as const
const ROW: Record<(typeof TABLES)[number], string> = {
  contacts: id(21),
  companies: id(22),
  deals: id(23),
  tasks: id(24),
}

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'], { migrate: false })
  d1 = local.bindings.G!
})
afterAll(async () => {
  await local.dispose()
})

const run = (sqlText: string, ...binds: unknown[]) => d1.batch([d1.prepare(sqlText).bind(...binds)])
const refused = (sqlText: string, ...binds: unknown[]) =>
  run(sqlText, ...binds).then(
    () => null,
    (e: Error) => e.message,
  )
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]

const insertRow = (table: (typeof TABLES)[number], rowId: string, extraCols = '', extraVals: unknown[] = []) => {
  const sqls = {
    contacts: `INSERT INTO contacts (id, organization_id, created_by, created_at, updated_at, name${extraCols}) VALUES (?, ?, ?, ?, ?, 'n'${extraVals.map(() => ', ?').join('')})`,
    companies: `INSERT INTO companies (id, organization_id, created_by, created_at, updated_at, name${extraCols}) VALUES (?, ?, ?, ?, ?, 'n'${extraVals.map(() => ', ?').join('')})`,
    tasks: `INSERT INTO tasks (id, organization_id, created_by, created_at, updated_at, title${extraCols}) VALUES (?, ?, ?, ?, ?, 't'${extraVals.map(() => ', ?').join('')})`,
    deals: `INSERT INTO deals (id, organization_id, created_by, created_at, updated_at, name, pipeline_id, stage_id${extraCols}) VALUES (?, ?, ?, ?, ?, 'd', '${PIPE}', '${STAGE}'${extraVals.map(() => ', ?').join('')})`,
  }
  return run(sqls[table], rowId, ORG, USER, AT, AT, ...extraVals)
}

describe('migration 0026_additional_props over a database at 0025', () => {
  it('leaves every existing row with {} and refuses a non-object bag on each table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig25-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0026')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await run(
      `INSERT INTO pipelines (id, organization_id, created_by, created_at, updated_at, name) VALUES (?, ?, ?, ?, ?, 'p')`,
      PIPE,
      ORG,
      USER,
      AT,
      AT,
    )
    await run(
      `INSERT INTO pipeline_stages (id, organization_id, created_by, created_at, updated_at, pipeline_id, name, kind, position) VALUES (?, ?, ?, ?, ?, ?, 's', 'open', 0)`,
      STAGE,
      ORG,
      USER,
      AT,
      AT,
      PIPE,
    )
    for (const t of TABLES) await insertRow(t, ROW[t])

    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0026'))
    expect(name).toBe('0026_additional_props.sql')
    const lone = mkdtempSync(join(tmpdir(), 'mig26only-'))
    cpSync(join(MIGRATIONS_DIR, name!), join(lone, name!))
    expect(await applyMigrations(d1, lone)).toEqual([name])

    for (const t of TABLES) {
      expect(await all(`select additional_props from ${t} where id = ?`, ROW[t])).toEqual([{ additional_props: '{}' }])
      // a writer that names no bag still succeeds (the column defaults)
      await insertRow(t, id(40 + TABLES.indexOf(t)))
      // an object is stored; a non-object is refused by the CHECK
      await insertRow(t, id(50 + TABLES.indexOf(t)), ', additional_props', ['{"a":1}'])
      for (const bad of ['[]', '1', '"x"', 'not json', 'null']) {
        expect(
          await refused(`UPDATE ${t} SET additional_props = ? WHERE id = ?`, bad, ROW[t]),
          `${t} update ${bad}`,
        ).toMatch(/CHECK|constraint/i)
        expect(
          await insertRow(t, id(60), ', additional_props', [bad]).then(
            () => null,
            (e: Error) => e.message,
          ),
          `${t} insert ${bad}`,
        ).toMatch(/CHECK|constraint/i)
      }
      expect(await refused(`UPDATE ${t} SET additional_props = NULL WHERE id = ?`, ROW[t])).toMatch(
        /NOT NULL|constraint/i,
      )
    }
    expect(await all('pragma foreign_key_check')).toEqual([])
  })
})
