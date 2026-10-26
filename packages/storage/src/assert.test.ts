import { describe, expect, it } from 'vitest'
import { sql, type SqlBool } from 'kysely'
import { UNIT_ASSERTION_CONSTRAINT, assertStep, exactly, queryContext, step, toCompiled } from './index.js'

const cond = sql<SqlBool>`1 = ${1}`

describe('assertStep (CORE36 C1, D4)', () => {
  it('compiles on d1 to an insert into the always-empty unit_assertion table, with no expectation', () => {
    const s = assertStep(queryContext('d1'), cond)
    const c = toCompiled(s.query)
    expect(c.sql).toMatch(/^insert into "unit_assertion" \("ok"\) select 0 where not \(.*\)$/)
    expect(c.parameters).toEqual([1])
    expect(s.expect).toBeUndefined()
  })

  it('compiles on postgres to a select of the condition as "holds", expected to hold', () => {
    const s = assertStep(queryContext('postgres'), cond)
    const c = toCompiled(s.query)
    expect(c.sql).toMatch(/^select \(.*\) as "holds"$/)
    expect(c.parameters).toEqual([1])
    expect(s.expect).toBe('holds')
  })

  it('names the constraint the d1 runtime classifies', () => {
    expect(UNIT_ASSERTION_CONSTRAINT).toBe('unit_assertion_holds')
  })
})

describe('exactly', () => {
  const update = (qc: ReturnType<typeof queryContext>) => step(qc.db.updateTable('tasks').set({ title: 'x' }), 'first-mutation')

  it('on postgres is the same step expecting exactly n rows', () => {
    const qc = queryContext('postgres')
    const out = exactly(qc, update(qc), 3)
    expect(out).toHaveLength(1)
    expect(out[0]!.expect).toEqual({ rows: 3 })
    expect(out[0]!.label).toBe('first-mutation')
  })

  it('on d1 is the step followed by an assertion on changes() = n', () => {
    const qc = queryContext('d1')
    const out = exactly(qc, update(qc), 3)
    expect(out).toHaveLength(2)
    expect(out[0]!.label).toBe('first-mutation')
    expect(out[0]!.expect).toBeUndefined()
    const c = toCompiled(out[1]!.query)
    expect(c.sql).toContain('unit_assertion')
    expect(c.sql).toContain('changes() = ?')
    expect(c.parameters).toEqual([3])
  })
})
