import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compareMigrations, readMigrationState, type D1Like } from './index.js'
import { clearD1, createMigrationTracker, openLocalD1, recordMigrations, type LocalD1 } from './test/index.js'

const EXPECTED = ['0001_a.sql', '0002_b.sql', '0003_c.sql']

describe('compareMigrations (D9)', () => {
  it('current: the same set, in any order', () => {
    expect(compareMigrations(EXPECTED, EXPECTED).status).toBe('current')
    expect(compareMigrations([...EXPECTED].reverse(), EXPECTED)).toEqual({ status: 'current', missing: [], extra: [] })
  })
  it('behind: something expected is missing', () => {
    expect(compareMigrations(EXPECTED.slice(0, 2), EXPECTED)).toEqual({ status: 'behind', missing: ['0003_c.sql'], extra: [] })
  })
  it('behind wins over extras (a diverged history)', () => {
    expect(compareMigrations(['0001_a.sql', '0002_renamed.sql', '0003_c.sql'], EXPECTED)).toEqual({
      status: 'behind',
      missing: ['0002_b.sql'],
      extra: ['0002_renamed.sql'],
    })
  })
  it('ahead: nothing missing, extras present', () => {
    expect(compareMigrations([...EXPECTED, '0004_d.sql'], EXPECTED)).toEqual({ status: 'ahead', missing: [], extra: ['0004_d.sql'] })
  })
  it('nothing applied and something expected is behind', () => {
    expect(compareMigrations([], EXPECTED)).toEqual({ status: 'behind', missing: EXPECTED, extra: [] })
  })
})

describe('readMigrationState (D6)', () => {
  let local: LocalD1
  let d1: D1Like
  beforeAll(async () => {
    local = await openLocalD1(['S'])
    d1 = local.bindings.S!
  })
  afterAll(() => local.dispose())
  beforeEach(async () => {
    await d1.prepare('drop table if exists d1_migrations').run()
  })

  it('a missing tracker is unknown, not a failed read', async () => {
    expect(await readMigrationState(d1, EXPECTED)).toEqual({ status: 'unknown', applied: [], readFailed: false })
  })
  it('a throwing read is unknown and flagged as failed', async () => {
    const broken: D1Like = { prepare: () => { throw new Error('D1 is unavailable') }, batch: () => Promise.reject(new Error('x')) }
    expect(await readMigrationState(broken, EXPECTED)).toEqual({ status: 'unknown', applied: [], readFailed: true })
  })
  it('reads each status from the tracker', async () => {
    await createMigrationTracker(d1)
    expect((await readMigrationState(d1, EXPECTED)).status).toBe('behind')
    await recordMigrations(d1, EXPECTED)
    expect(await readMigrationState(d1, EXPECTED)).toEqual({ status: 'current', applied: EXPECTED, readFailed: false })
    await recordMigrations(d1, ['0009_z.sql'])
    expect((await readMigrationState(d1, EXPECTED)).status).toBe('ahead')
  })
})

describe('clearD1 keeps the tracker (D10)', () => {
  it('the harness creates no tracker, and clearD1 leaves recorded migrations in place', async () => {
    const local = await openLocalD1(['C'])
    const d1 = local.bindings.C!
    try {
      expect((await readMigrationState(d1, EXPECTED)).status).toBe('unknown')
      await createMigrationTracker(d1)
      await recordMigrations(d1, EXPECTED)
      await clearD1(d1)
      const { results } = await d1.prepare('select name from d1_migrations order by name').all()
      expect(results?.map((r) => (r as { name: string }).name)).toEqual(EXPECTED)
    } finally {
      await local.dispose()
    }
  })
})
