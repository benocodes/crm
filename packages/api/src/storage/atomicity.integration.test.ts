import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CommitOutcomeUnknown,
  CommittedResultInvalid,
  SetLimitExceeded,
  StatementFailed,
  boundIds,
  defineOperation,
  memberOf,
  readSet,
  selectColumns,
  step,
  unit,
  uuidv7,
  type PreparedOperation,
  type StatementLabel,
  type StorageBinding,
} from '@vault/storage'
import { withFault } from '@vault/storage/test'
import { postgresBinding } from '@vault/storage-postgres'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { createOperation, updateOperation } from './crud.js'
import { tasks } from '../resources/tasks.js'
import { openEngines, type Engine } from './engines.js'

const LABELS: readonly StatementLabel[] = ['first-mutation', 'first-event', 'result']
const NOW = new Date('2026-10-22T10:00:00.000Z')
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('atomicity on %s', (name) => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })

  describe.each(LABELS)('a real constraint fault after %s', (label) => {
    it('rolls back a create: no task, no event', async () => {
      const err = await settle(e.run(withFault(createOperation(tasks, e.env({ now: NOW }), { title: 'x' }), { after: label })))
      expect(err).toBeInstanceOf(StatementFailed)
      expect((err as StatementFailed).kind).toBe('not_null')
      expect(await e.tasks()).toHaveLength(0)
      expect(await e.events()).toHaveLength(0)
    })

    it('rolls back an update: row and event chain unchanged', async () => {
      const id = uuidv7()
      await e.insertTask({ id, title: 'before' })
      const before = await e.tasks()
      const err = await settle(e.run(withFault(updateOperation(tasks, e.env({ now: NOW }), id, { title: 'after', status: 'done' }), { after: label })))
      expect(err).toBeInstanceOf(StatementFailed)
      expect(await e.tasks()).toEqual(before)
      expect(await e.events()).toHaveLength(0)
    })
  })

  it('an over-cap synthetic program refuses and changes nothing, and the same program passes with a larger cap (D7, D8)', async () => {
    for (let i = 0; i < 5; i++) await e.insertTask({ id: uuidv7(), title: `t${i}` })
    const completeAll: PreparedOperation<number> = defineOperation({
      name: 'tasks.complete_all',
      mutates: true,
      reads: (qc) => ({ open: readSet(selectColumns(qc, 'tasks', ['id'])) }),
      build: (found, qc) => {
        const ids = found.all('open').map((r) => String(r.id))
        return unit({
          steps: [
            step(
              qc.db.updateTable('tasks').set({ status: 'done', updated_at: NOW.toISOString() }).where(memberOf(qc, 'tasks', 'id', boundIds(qc, ids))),
              'first-mutation',
            ),
          ],
          events: [],
          decode: () => ids.length,
        })
      },
    })
    const small: StorageBinding =
      name === 'postgres' ? postgresBinding(e.app!, { maxSetSize: 4 }) : d1Binding(e.d1!, { organizationId: e.organizationId, maxSetSize: 4 })
    const big: StorageBinding =
      name === 'postgres' ? postgresBinding(e.app!, { maxSetSize: 500 }) : d1Binding(e.d1!, { organizationId: e.organizationId, maxSetSize: 500 })
    const identity = { actorId: e.userId, organizationId: e.organizationId }
    const { execute } = await import('@vault/storage')
    const err = await settle(execute(small, identity, completeAll))
    expect(err).toBeInstanceOf(SetLimitExceeded)
    expect((await e.tasks()).map((t) => t.status)).toEqual(Array(5).fill('open'))
    expect((await execute(big, identity, completeAll)).value).toBe(5)
    expect((await e.tasks()).map((t) => t.status)).toEqual(Array(5).fill('done'))
  })

  if (name === 'postgres') {
    it('a malformed final record rolls the whole unit back before commit', async () => {
      const op = createOperation(tasks, e.env({ now: NOW }), { title: 'x' })
      const invalid: PreparedOperation<unknown> = { ...op, build: (found, qc) => ({ ...op.build(found, qc), decode: () => tasks.record.parse({ id: 'not a record' }) }) }
      const err = await settle(e.run(invalid))
      expect(err).toBeDefined()
      expect(await e.tasks()).toHaveLength(0)
      expect(await e.events()).toHaveLength(0)
    })
  }

  if (name === 'd1') {
    it('a decode failure after a valid commit is committed_result_invalid: the unit is committed, never replayed', async () => {
      const op = createOperation(tasks, e.env({ now: NOW }), { title: 'x' })
      const invalid: PreparedOperation<unknown> = { ...op, build: (found, qc) => ({ ...op.build(found, qc), decode: () => tasks.record.parse({ id: 'not a record' }) }) }
      const err = await settle(e.run(invalid))
      expect(err).toBeInstanceOf(CommittedResultInvalid)
      expect(await e.tasks()).toHaveLength(1)
      expect(await e.events()).toHaveLength(1)
    })

    it('a lost transport after the commit is commit_outcome_unknown: reported, not replayed, not success', async () => {
      const real = e.d1!
      let batches = 0
      const flaky: D1Like = {
        prepare: (q) => real.prepare(q),
        batch: async (statements) => {
          const results = await real.batch(statements)
          batches += 1
          if (statements.length >= 3) throw new Error('D1_ERROR: Network connection lost')
          return results
        },
      }
      const binding = d1Binding(flaky, { organizationId: e.organizationId })
      const { execute } = await import('@vault/storage')
      const err = await settle(execute(binding, { actorId: e.userId, organizationId: e.organizationId }, createOperation(tasks, e.env({ now: NOW }), { title: 'x' })))
      expect(err).toBeInstanceOf(CommitOutcomeUnknown)
      expect(batches).toBe(1) // an assignee-free create has no plan-phase reads: exactly one batch ran, and it was not replayed
      expect(await e.tasks()).toHaveLength(1)
    })
  }
})
