import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { bind, jsonRows, queryContext, recordJson, toCompiled } from './index.js'

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `0190b2c4-0000-7000-8000-${String(i).padStart(12, '0')}`, own: i % 2 === 0, before: { n: i } }))
const columns = { id: 'uuid', own: 'boolean', before: 'json' } as const
const select = (dialect: 'd1' | 'postgres', n: number) => {
  const qc = queryContext(dialect)
  return sql`select r.id, r.own, r.before, r.ord from ${jsonRows(qc, 'r', columns, rows(n))}`.compile(qc.db)
}

describe('jsonRows (CORE36 C1, D5)', () => {
  it('binds the whole set as ONE parameter on d1 and reads it through json_each', () => {
    const c = select('d1', 150)
    expect(c.parameters).toHaveLength(1)
    expect(JSON.parse(c.parameters[0] as string)).toHaveLength(150)
    expect(c.sql).toContain('json_each')
    expect(c.sql).toMatch(/key as "?ord"?/)
  })

  it('binds the whole set as ONE parameter on postgres and reads it through jsonb_array_elements with ordinality', () => {
    const c = select('postgres', 150)
    expect(c.parameters).toHaveLength(1)
    expect(c.sql).toContain('jsonb_array_elements(')
    expect(c.sql).toContain('with ordinality')
    expect(c.sql).toContain('::uuid')
    expect(c.sql).toContain('::boolean')
    expect(c.sql).toContain("e->'before'")
  })

  it('stays within the d1 parameter limit however many rows travel', () => {
    expect(select('d1', 150).parameters.length).toBeLessThanOrEqual(100)
  })
})

describe('boolean columns in the dialect fragments', () => {
  it('bind casts a boolean on postgres', () => {
    const qc = queryContext('postgres')
    const c = sql`select ${bind(qc, 'boolean', true)}`.compile(qc.db)
    expect(c.sql).toContain('cast($1 as boolean)')
  })

  it('recordJson renders a boolean as a JSON boolean on d1 and unchanged on postgres', () => {
    const d1 = queryContext('d1')
    const pg = queryContext('postgres')
    const a = sql`select ${recordJson(d1, 'identities', ['own'])}`.compile(d1.db).sql
    const b = sql`select ${recordJson(pg, 'identities', ['own'])}`.compile(pg.db).sql
    expect(a).toMatch(/json\(iif\("identities"\."own", 'true', 'false'\)\)/)
    expect(b).toContain('jsonb_build_object')
    expect(b).not.toContain('iif(')
  })
})

describe('integer columns in jsonRows (CORE25 P5)', () => {
  it('casts an integer column to bigint on Postgres', () => {
    const qc = queryContext('postgres')
    const c = sql`select r.n from ${jsonRows(qc, 'r', { n: 'integer' }, [{ n: 3 }])}`.compile(qc.db)
    expect(c.sql).toContain("(e->>'n')::bigint")
  })
})
