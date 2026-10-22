import { describe, expect, it } from 'vitest'
import {
  ColdExecutionError,
  bind,
  coldDb,
  compileOperation,
  defineOperation,
  eq,
  queryContext,
  readMaybe,
  selectColumns,
  step,
  unit,
  type Dialect,
} from './index.js'

const ID = '0190b2c4-0000-7000-8000-000000000001'
const EVENT = '0190b2c4-0000-7000-8000-000000000002'
const NOW = '2026-10-22T09:00:00.000Z'
const HOSTILE = "x'); DROP TABLE tasks; --"
const dialects: readonly Dialect[] = ['postgres', 'd1']

/** A typed select, a guarded update, an insert...select and a result select, as one operation. */
const rename = defineOperation<{ id: string }>({
  name: 'tasks.rename',
  mutates: true,
  reads: (qc) => ({ before: readMaybe(selectColumns(qc, 'tasks', ['id', 'title']).where(eq('tasks', 'id', ID))) }),
  build: (_found, qc) =>
    unit({
      steps: [
        step(
          qc.db
            .updateTable('tasks')
            .set({ title: HOSTILE, updated_at: NOW })
            .where(eq('tasks', 'id', ID))
            .where(eq('tasks', 'status', 'open')),
          'first-mutation',
        ),
        step(
          qc.db
            .insertInto('events')
            .columns(['id', 'organization_id', 'type', 'resource_type', 'resource_id', 'actor_id', 'created_at'])
            .expression((eb) =>
              eb
                .selectFrom('tasks')
                .select([
                  bind(qc, 'uuid', EVENT).as('id'),
                  'tasks.organization_id as organization_id',
                  bind(qc, 'text', 'task.updated').as('type'),
                  bind(qc, 'text', 'task').as('resource_type'),
                  'tasks.id as resource_id',
                  'tasks.created_by as actor_id',
                  bind(qc, 'timestamp', NOW).as('created_at'),
                ])
                .where(eq('tasks', 'id', ID)),
            ),
          'first-event',
        ),
        step(selectColumns(qc, 'tasks', ['id', 'title']).where(eq('tasks', 'id', ID)), 'result'),
      ],
      events: [{ id: EVENT, type: 'task.updated', resourceType: 'task', resourceId: ID }],
      decode: (rows) => ({ id: String(rows[0]!.id) }),
    }),
})

describe('compileOperation', () => {
  it.each(dialects)('numbers placeholders for %s and binds caller strings', (dialect) => {
    const compiled = compileOperation(rename, dialect, { before: { id: ID, title: 'old' } })
    const sqlText = [...compiled.reads, ...compiled.statements].map((s) => s.sql).join('\n')
    if (dialect === 'postgres') {
      expect(sqlText).toMatch(/\$1/)
      expect(sqlText).not.toContain('?')
    } else {
      expect(sqlText).toContain('?')
      expect(sqlText).not.toMatch(/\$\d/)
    }
    // The hostile string is a bound parameter, never SQL text.
    expect(sqlText).not.toContain('DROP TABLE')
    expect(compiled.statements[0]!.parameters).toContain(HOSTILE)
  })

  it.each(dialects)('keeps a fixed statement and result order for %s', (dialect) => {
    const compiled = compileOperation(rename, dialect, { before: { id: ID, title: 'old' } })
    expect(compiled.reads.map((r) => r.key)).toEqual(['before'])
    expect(compiled.statements.map((s) => s.label)).toEqual(['first-mutation', 'first-event', 'result'])
    expect(compiled.statements[0]!.sql).toMatch(/^update "tasks"/)
    expect(compiled.statements[1]!.sql).toMatch(/^insert into "events"/)
    expect(compiled.statements[2]!.sql).toMatch(/^select /)
    expect(compiled.events).toEqual([{ id: EVENT, type: 'task.updated', resourceType: 'task', resourceId: ID }])
  })

  it('casts bound values on Postgres only (an unknown-typed parameter in INSERT...SELECT would be text)', () => {
    const pg = compileOperation(rename, 'postgres', { before: null }).statements[1]!.sql
    const d1 = compileOperation(rename, 'd1', { before: null }).statements[1]!.sql
    expect(pg).toMatch(/cast\(\$\d+ as uuid\)/i)
    expect(d1).not.toMatch(/cast/i)
  })

  it.each(dialects)('refuses to run a cold builder on %s', async (dialect) => {
    const query = selectColumns(queryContext(dialect), 'tasks', ['id'])
    await expect(query.execute()).rejects.toBeInstanceOf(ColdExecutionError)
    await expect(coldDb(dialect).selectFrom('tasks').selectAll().executeTakeFirst()).rejects.toBeInstanceOf(ColdExecutionError)
  })
})
