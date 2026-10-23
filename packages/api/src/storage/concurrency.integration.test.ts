import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { tasks } from '../resources/tasks.js'
import { ApiError, mapStorageError } from '../errors.js'
import { createOperation, deleteOperation, updateOperation } from './crud.js'
import { openEngines, type Engine, type RawRow } from '../test/engines.js'

// Coordinated starts, no sleeps, no retries masking failures ([[CORE35]] D16). Assertions are on the final
// state and a valid event chain, never on which contender won.
const T = (n: number) => new Date(Date.parse('2026-10-22T10:00:00.000Z') + n * 1000)

/** Starts every contender at once behind a gate. */
async function together(starts: Array<() => Promise<unknown>>): Promise<PromiseSettledResult<unknown>[]> {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const running = starts.map((s) => gate.then(s))
  open()
  return Promise.allSettled(running)
}

/** Each event's `before` is the previous event's `after`, the first is the create, and the last `after` is the stored row. */
function assertChain(events: RawRow[], stored: RawRow | undefined, id: string): void {
  const own = events.filter((e) => e.resource_id === id)
  expect(own.length).toBeGreaterThan(0)
  expect(own[0]!.type).toBe('task.created')
  for (let i = 1; i < own.length; i++) expect(own[i]!.before).toEqual(own[i - 1]!.after)
  const last = own.at(-1)!.after
  if (last !== null) expect(last).toMatchObject({ id, title: stored!.title, status: stored!.status, notes: stored!.notes })
  else expect(stored!.deleted_at).not.toBeNull()
}

/** The same mapping the app applies: drift becomes a retryable 409. Anything unmapped stays a raw error and fails the test. */
const mapped = <T>(p: Promise<T>): Promise<T> => p.catch((err: unknown) => Promise.reject(mapStorageError(err)))

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines({ maxConnections: 8 })
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('concurrent task writes on %s', (name) => {
  let e: Engine
  const TRIALS = name === 'postgres' ? 20 : 5
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })

  const fresh = async () => (await e.run(createOperation(tasks, e.env({ now: T(0) }), { title: 'start' }))).value.id

  it(`two updates on disjoint fields (${TRIALS} trials)`, async () => {
    const tally = { both: 0, one: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const id = await fresh()
      const settled = await together([
        () => mapped(e.run(updateOperation(tasks, e.env({ now: T(1) }), id, { title: 'T' }))),
        () => mapped(e.run(updateOperation(tasks, e.env({ now: T(2), as: 'agent' }), id, { notes: 'N' }), 'agent')),
      ])
      const ok = settled.filter((r) => r.status === 'fulfilled').length
      const [stored] = await e.tasks()
      const events = await e.events()
      assertChain(events, stored, id)
      expect(events.length).toBe(1 + ok)
      if (name === 'postgres') {
        // The organisation writer lock serialises the units: both land, and neither overwrote the other.
        expect(ok).toBe(2)
        expect(stored).toMatchObject({ title: 'T', notes: 'N' })
        tally.both++
      } else {
        // A double submit on D1: the loser's drift guard makes its unit a no-op (a retryable 409); never a lost update.
        for (const r of settled) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'conflict' })
        expect(ok).toBeGreaterThanOrEqual(1)
        if (ok === 2) expect(stored).toMatchObject({ title: 'T', notes: 'N' })
        ok === 2 ? tally.both++ : tally.one++
      }
    }
    console.log(`[concurrency] ${name} disjoint fields: both landed ${tally.both}, one conflicted ${tally.one} of ${TRIALS}`)
  })

  it(`two competing status changes with distinct injected times (${TRIALS} trials)`, async () => {
    const tally = { done: 0, open: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const id = await fresh()
      const settled = await together([
        () => mapped(e.run(updateOperation(tasks, e.env({ now: T(5) }), id, { status: 'done' }))),
        () => mapped(e.run(updateOperation(tasks, e.env({ now: T(6), as: 'agent' }), id, { status: 'open' }), 'agent')),
      ])
      for (const r of settled) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'conflict' })
      const [stored] = await e.tasks()
      assertChain(await e.events(), stored, id)
      // completed_at is consistent with the final status whoever won.
      if (stored!.status === 'done') {
        expect(stored!.completed_at).not.toBeNull()
        tally.done++
      } else {
        expect(stored!.completed_at).toBeNull()
        tally.open++
      }
      if (name === 'postgres') expect(settled.every((r) => r.status === 'fulfilled')).toBe(true)
    }
    console.log(`[concurrency] ${name} competing status: final done ${tally.done}, open ${tally.open} of ${TRIALS}`)
  })

  it(`a task write racing the deletion of the task (${TRIALS} trials)`, async () => {
    // (Principals cannot be deleted, so the reference race is exercised against the task row itself.)
    const tally = { updatedThenDeleted: 0, deletedFirst: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const id = await fresh()
      const settled = await together([
        () => mapped(e.run(updateOperation(tasks, e.env({ now: T(1) }), id, { assignee_id: e.user2Id }))),
        () => mapped(e.run(deleteOperation(tasks, e.env({ now: T(2) }), id))),
      ])
      for (const r of settled) if (r.status === 'rejected') expect(['not_found', 'conflict']).toContain((r.reason as ApiError).code)
      const [stored] = await e.tasks()
      // Postgres serialises the units, so the delete always lands; on D1 a delete that drifted is a retryable 409 and the row stays live.
      if (name === 'postgres' || settled[1]!.status === 'fulfilled') expect(stored!.deleted_at).not.toBeNull()
      else expect(stored!.deleted_at).toBeNull()
      assertChain(await e.events(), stored, id)
      const types = (await e.events()).map((ev) => ev.type)
      types.includes('task.updated') ? tally.updatedThenDeleted++ : tally.deletedFirst++
    }
    console.log(`[concurrency] ${name} update vs delete: update landed first ${tally.updatedThenDeleted}, delete only ${tally.deletedFirst} of ${TRIALS}`)
  })
})
