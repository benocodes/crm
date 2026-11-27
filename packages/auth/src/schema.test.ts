import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUTH_TABLES } from './index.js'
import { CONTROL_DEPLOYMENT_DDL, generateAuthDdl } from './test/schema-gen.js'

const MIGRATION = fileURLToPath(new URL('../../storage-d1/control-migrations/0001_genesis.sql', import.meta.url))
const statements = (text: string) =>
  text
    .split(';')
    .map((s) =>
      s
        .replace(/--.*$/gm, '')
        .trim()
        .replace(/^create (unique )?(table|index)\b/i, (m) => m.toLowerCase()),
    )
    .filter(Boolean)

// [[CORE243]] D4, [[CORE259]] D4/D13, [[CORE678]] D6: control genesis BEGINS with the offline-generated DDL, then the control marker, then the rest of the control schema. A library upgrade
// or an option change that alters the schema fails here until the change is written into genesis by hand (before the first public release) or into a new migration (after it).
// SQLite's catalogue spells the leading CREATE keywords in capitals, so those are compared in lower case.
describe('the auth schema (D4)', () => {
  it('control genesis begins with exactly what Better Auth generates for the composed options, then control_deployment', async () => {
    const expected = [...statements(await generateAuthDdl()), ...statements(CONTROL_DEPLOYMENT_DDL)]
    expect(statements(readFileSync(MIGRATION, 'utf8')).slice(0, expected.length)).toEqual(expected)
  })

  it('every table is auth_ prefixed, every column snake_case, and the tables are the exported list', async () => {
    const ddl = await generateAuthDdl()
    const tables = [...ddl.matchAll(/create table "([^"]+)"/g)].map((m) => m[1]!)
    expect([...tables].sort()).toEqual([...AUTH_TABLES].sort())
    expect(tables.length).toBeGreaterThanOrEqual(13)
    for (const t of tables) expect(t, t).toMatch(/^auth_[a-z]+(_[a-z]+)*$/)
    const columns = [...ddl.matchAll(/create table "[^"]+" \(([^;]+)\);/g)].flatMap((m) =>
      [...m[1]!.matchAll(/"([^"]+)" (?:text|integer|date|real|blob)/g)].map((c) => c[1]!),
    )
    expect(columns.length).toBeGreaterThan(100)
    for (const c of columns) expect(c, c).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
    expect(tables).toEqual(expect.arrayContaining(['auth_device_codes', 'auth_rate_limits', 'auth_jwks', 'auth_users']))
  })
})
