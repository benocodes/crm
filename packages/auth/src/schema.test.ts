import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUTH_TABLES } from './index.js'
import { generateAuthDdl } from './test/schema-gen.js'

const MIGRATION = fileURLToPath(new URL('../../storage-d1/migrations/0018_auth_tables.sql', import.meta.url))
const statements = (text: string) =>
  text
    .split(';')
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)

// [[CORE243]] D4: the migration IS the offline-generated DDL. A library upgrade or an option change that alters the schema fails here until a new reviewed migration is written.
describe('the auth schema (D4)', () => {
  it('migration 0018 is exactly what Better Auth generates for the composed options', async () => {
    expect(statements(readFileSync(MIGRATION, 'utf8'))).toEqual(statements(await generateAuthDdl()))
  })

  it('every table is auth_ prefixed, every column snake_case, and the tables are the exported list', async () => {
    const ddl = await generateAuthDdl()
    const tables = [...ddl.matchAll(/create table "([^"]+)"/g)].map((m) => m[1]!)
    expect([...tables].sort()).toEqual([...AUTH_TABLES].sort())
    expect(tables.length).toBeGreaterThanOrEqual(13)
    for (const t of tables) expect(t, t).toMatch(/^auth_[a-z]+(_[a-z]+)*$/)
    const columns = [...ddl.matchAll(/create table "[^"]+" \(([^;]+)\);/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)" (?:text|integer|date|real|blob)/g)].map((c) => c[1]!))
    expect(columns.length).toBeGreaterThan(100)
    for (const c of columns) expect(c, c).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
    expect(tables).toEqual(expect.arrayContaining(['auth_device_codes', 'auth_rate_limits', 'auth_jwks', 'auth_users']))
  })
})
