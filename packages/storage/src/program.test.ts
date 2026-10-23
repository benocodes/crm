import { describe, expect, it } from 'vitest'
import { withFault } from './test/index.js'
import {
  bind,
  compileOperation,
  defineOperation,
  eq,
  queryContext,
  readMaybe,
  selectColumns,
  step,
  unit,
  type Dialect,
  type StatementLabel,
} from './index.js'

const ID = '0190b2c4-0000-7000-8000-000000000001'
const EVENT = '0190b2c4-0000-7000-8000-000000000002'
const NOW = '2026-10-22T09:00:00.000Z'
const PLAINTEXT = 'vk_plaintext-secret-value'
const HASH = 'a'.repeat(64)
const dialects: readonly Dialect[] = ['postgres', 'd1']
const LABELS: readonly StatementLabel[] = ['first-mutation', 'first-event', 'result']

/** Mutation, event, result; the key plaintext is hashed outside and only the hash is bound. */
const program = defineOperation<string>({
  name: 'keys.issue',
  mutates: true,
  reads: () => ({}),
  build: (_found, qc) =>
    unit({
      steps: [
        step(qc.db.updateTable('tasks').set({ title: HASH, updated_at: NOW }).where(eq('tasks', 'id', ID)), 'first-mutation', { expect: 'affected' }),
        step(
          qc.db
            .insertInto('events')
            .columns(['id', 'organization_id', 'type', 'resource_type', 'resource_id', 'actor_id', 'created_at'])
            .expression((eb) =>
              eb.selectFrom('tasks').select([
                bind(qc, 'uuid', EVENT).as('id'),
                'tasks.organization_id as organization_id',
                bind(qc, 'text', 'task.updated').as('type'),
                bind(qc, 'text', 'task').as('resource_type'),
                'tasks.id as resource_id',
                'tasks.created_by as actor_id',
                bind(qc, 'timestamp', NOW).as('created_at'),
              ]),
            ),
          'first-event',
        ),
        step(selectColumns(qc, 'tasks', ['id']).where(eq('tasks', 'id', ID)), 'result'),
      ],
      events: [{ id: EVENT, type: 'task.updated', resourceType: 'task', resourceId: ID }],
      decode: (rows) => String(rows[0]?.id),
    }),
})

describe('program composition', () => {
  it.each(dialects)('orders mutation, then event, then result on %s', (dialect) => {
    const labels = compileOperation(program, dialect).statements.map((s) => s.label)
    expect(labels).toEqual(LABELS)
  })

  it('builds without a prior row: build is synchronous and takes only the found reads', () => {
    const built = program.build(compileOperation(program, 'd1').found, queryContext('d1'))
    expect(built).not.toBeInstanceOf(Promise)
    expect(built.steps).toHaveLength(3)
  })

  it.each(LABELS.flatMap((label) => dialects.map((dialect) => [label, dialect] as const)))(
    'injects a fault after %s on %s and keeps every other stage in order',
    (label, dialect) => {
      const faulty = withFault(program, { after: label })
      const labels = compileOperation(faulty, dialect).statements.map((s) => s.label ?? 'unlabelled')
      const at = LABELS.indexOf(label)
      expect(labels).toHaveLength(4)
      expect(labels[at + 1]).toBe('fault')
      expect(labels.filter((l) => l !== 'fault')).toEqual(LABELS)
      // The fault is a real constraint violation, not a thrown error.
      const fault = compileOperation(faulty, dialect).statements[at + 1]!
      expect(fault.sql).toMatch(/^insert into "tasks"/i)
      expect(fault.sql).toMatch(/null/i)
    },
  )

  it.each(dialects)('never binds a secret plaintext on %s: only the hash reaches a statement', (dialect) => {
    const compiled = compileOperation(program, dialect)
    const params = compiled.statements.flatMap((s) => s.parameters)
    expect(params).toContain(HASH)
    expect(params).not.toContain(PLAINTEXT)
    expect(compiled.statements.map((s) => s.sql).join('\n')).not.toContain(PLAINTEXT)
  })

  it('rejects a unit with a second result, an event before its mutation, or a mutation after the result', () => {
    const qc = queryContext('d1')
    const select = () => selectColumns(qc, 'tasks', ['id'])
    const update = () => qc.db.updateTable('tasks').set({ title: 'x' })
    const base = { events: [], decode: () => null }
    expect(() => unit({ ...base, steps: [step(select(), 'result'), step(select(), 'result')] })).toThrow(/result/)
    expect(() => unit({ ...base, steps: [step(update(), 'first-event'), step(update(), 'first-mutation')] })).toThrow(/order/)
    expect(() => unit({ ...base, steps: [step(select(), 'result'), step(update(), 'first-mutation')] })).toThrow(/order/)
  })

  it('reads that need no rows can be absent', () => {
    const op = defineOperation<null>({ name: 'noop', mutates: false, reads: () => ({ a: readMaybe(selectColumns(queryContext('d1'), 'tasks', ['id'])) }), build: () => unit({ steps: [], events: [], decode: () => null }) })
    expect(compileOperation(op, 'd1', { a: null }).statements).toEqual([])
  })
})
