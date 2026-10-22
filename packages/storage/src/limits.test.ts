import { describe, expect, it } from 'vitest'
import {
  SetLimitExceeded,
  boundIds,
  compileOperation,
  defineOperation,
  eq,
  memberOf,
  planUnit,
  queryContext,
  readSet,
  selectColumns,
  step,
  unit,
  type Dialect,
  type Row,
} from './index.js'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `0190b2c4-0000-7000-8000-${String(i + 1).padStart(12, '0')}`)
const dialects: readonly Dialect[] = ['postgres', 'd1']

/**
 * A domain program that knows nothing about any cap: it reads a set of ids and writes one set-oriented
 * statement over them (the shape of a cascade).
 */
const cascade = defineOperation<number>({
  name: 'tasks.complete_all',
  mutates: true,
  reads: (qc) => ({ open: readSet(selectColumns(qc, 'tasks', ['id']).where(eq('tasks', 'status', 'open'))) }),
  build: (found, qc) => {
    const open = found.all('open').map((r) => String(r.id))
    return unit({
      steps: [
        step(
          qc.db
            .updateTable('tasks')
            .set({ status: 'done', updated_at: '2026-10-22T09:00:00.000Z' })
            .where(memberOf(qc, 'tasks', 'id', boundIds(qc, open))),
          'first-mutation',
        ),
      ],
      events: [],
      decode: () => open.length,
    })
  },
})

/** A read executor that answers the set read with `n` rows and records what ran. */
function fakeReads(n: number) {
  const ran: string[] = []
  return {
    ran,
    run: async (reads: ReadonlyArray<{ key: string; sql: string; parameters: readonly unknown[] }>): Promise<Record<string, readonly Row[]>> => {
      ran.push(...reads.map((r) => r.sql))
      return Object.fromEntries(reads.map((r) => [r.key, ids(n).map((id) => ({ id }))]))
    },
  }
}

describe('bounded sets', () => {
  it.each([0, 100])('plans a set of %i at cap 100', async (n) => {
    const reads = fakeReads(n)
    const planned = await planUnit(cascade, queryContext('d1', 100), reads.run)
    expect(planned.unit.steps).toHaveLength(1)
  })

  it('refuses 101 at cap 100 before building anything', async () => {
    const reads = fakeReads(101)
    const err = await planUnit(cascade, queryContext('d1', 100), reads.run).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SetLimitExceeded)
    expect((err as SetLimitExceeded).limit).toBe(100)
  })

  it('accepts the same program, unchanged, at cap 500', async () => {
    const reads = fakeReads(101)
    const planned = await planUnit(cascade, queryContext('postgres', 500), reads.run)
    expect(planned.unit.decode([], planned.found)).toBe(101)
  })

  it('reads the set one past the cap so a larger set is detected, not truncated', () => {
    const compiled = compileOperation(cascade, 'd1', { open: [] }, { maxSetSize: 100 })
    expect(compiled.reads[0]!.limit).toBe(101)
    expect(compileOperation(cascade, 'd1', { open: [] }, { maxSetSize: 500 }).reads[0]!.limit).toBe(501)
  })

  it('boundIds refuses an over-cap id list before any statement exists', () => {
    expect(boundIds(queryContext('d1', 100), ids(100))).toHaveLength(100)
    expect(() => boundIds(queryContext('d1', 100), ids(101))).toThrow(SetLimitExceeded)
    expect(boundIds(queryContext('d1', 500), ids(101))).toHaveLength(101)
  })

  it.each(dialects)('binds a set as ONE parameter on %s (D19), whatever its size', (dialect) => {
    for (const n of [0, 1, 100]) {
      const found = { open: ids(n).map((id) => ({ id })) }
      const update = compileOperation(cascade, dialect, found).statements[0]!
      // status, updated_at, and the single set parameter.
      expect(update.parameters).toHaveLength(3)
      const set = update.parameters[2]
      if (dialect === 'postgres') {
        expect(update.sql).toMatch(/= any\(\$3::uuid\[\]\)/i)
        expect(set).toEqual(ids(n))
      } else {
        expect(update.sql).toMatch(/in \(select value from json_each\(\?\)\)/i)
        expect(JSON.parse(set as string)).toEqual(ids(n))
      }
    }
  })
})
