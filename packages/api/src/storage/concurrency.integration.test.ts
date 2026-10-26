import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { tasks } from '../resources/tasks.js'
import { companies } from '../resources/companies.js'
import { identities } from '../resources/identities.js'
import { mergeOperation } from '../identity/merge.js'
import { resolveOperation } from '../identity/resolve.js'
import { identityKit } from '../test/identity-kit.js'
import { issueApiKeyOperation, revokeApiKeyOperation } from '../admin/api-keys.js'
import { generateApiKey } from '../auth/api-keys.js'
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

// ---- the identity model (CORE36 D13): the writer lock and the unique constraints are the only protection ---------
describe.each(['postgres', 'd1'] as const)('concurrent identity-model writes on %s', (name) => {
  let e: Engine
  const TRIALS = name === 'postgres' ? 20 : 5
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  const code = (r: PromiseRejectedResult) => (r.reason as ApiError).code

  it(`two company creates with one domain: one lands, the other is domain_exists${name === 'd1' ? ' or a conflict' : ''} (${TRIALS} trials)`, async () => {
    const tally = { domainExists: 0, conflict: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const k = identityKit(e)
      const settled = await together([
        () => mapped(e.run(createOperation(companies, k.env(), { name: 'A', domain: 'race.com' }))),
        () => mapped(e.run(createOperation(companies, k.env({ as: 'agent' }), { name: 'B', domain: 'race.com' }), 'agent')),
      ])
      const ok = settled.filter((r) => r.status === 'fulfilled').length
      expect(ok).toBe(1)
      const lost = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
      if (name === 'postgres') expect(code(lost)).toBe('domain_exists')
      else expect(['domain_exists', 'conflict']).toContain(code(lost))
      code(lost) === 'domain_exists' ? tally.domainExists++ : tally.conflict++
      expect((await e.rows('companies')).filter((c) => c.domain === 'race.com' && c.deleted_at === null)).toHaveLength(1)
      expect((await e.rows('events')).filter((x) => x.type === 'company.created')).toHaveLength(1)
    }
    console.log(`[concurrency] ${name} same domain: domain_exists ${tally.domainExists}, conflict ${tally.conflict} of ${TRIALS}`)
  })

  it(`two resolves with overlapping addresses: one identity per address, no contact without an identity (${TRIALS} trials)`, async () => {
    const tally = { both: 0, one: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const k = identityKit(e)
      const entry = (v: string) => ({ kind: 'email' as const, value: `${v}@race.com` })
      const settled = await together([
        () => mapped(e.run(resolveOperation(k.env(), [entry('a'), entry('b')]))),
        () => mapped(e.run(resolveOperation(k.env({ as: 'agent' }), [entry('b'), entry('c')]), 'agent')),
      ])
      for (const r of settled) if (r.status === 'rejected') expect(code(r)).toBe('conflict')
      const ok = settled.filter((r) => r.status === 'fulfilled').length
      expect(ok).toBeGreaterThanOrEqual(1)
      if (name === 'postgres') expect(ok).toBe(2)
      ok === 2 ? tally.both++ : tally.one++
      const ids = (await e.rows('identities')).filter((x) => x.deleted_at === null)
      const values = ids.map((x) => x.value)
      expect(new Set(values).size).toBe(values.length)
      const cs = await e.rows('contacts')
      for (const c of cs) expect(ids.some((x) => x.contact_id === c.id), `contact ${c.id} has an identity`).toBe(true)
      expect(cs).toHaveLength(ids.length)
    }
    console.log(`[concurrency] ${name} overlapping resolves: both landed ${tally.both}, one conflicted ${tally.one} of ${TRIALS}`)
  })

  it(`a merge racing an identity create on the source: a serial outcome, never a live identity on a tombstone (${TRIALS} trials)`, async () => {
    const tally = { createThenMerge: 0, mergeThenRefused: 0, conflict: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const k = identityKit(e)
      const s = await k.contact({})
      const r = await k.contact({})
      const settled = await together([
        () => mapped(e.run(createOperation(identities, k.env(), { kind: 'email', value: 'race@race.com', contact_id: r.id }))),
        () => mapped(e.run(mergeOperation(k.env({ as: 'agent' }), s.id, r.id), 'agent')),
      ])
      for (const x of settled) if (x.status === 'rejected') expect(['invalid_reference', 'conflict']).toContain(code(x))
      const live = (await e.rows('identities')).filter((x) => x.deleted_at === null)
      const tomb = (await e.rows('contacts')).filter((c) => c.deleted_at !== null).map((c) => c.id)
      for (const idn of live) expect(tomb, 'no live identity on a tombstone').not.toContain(idn.contact_id)
      if (name === 'postgres') {
        expect(settled[1]!.status).toBe('fulfilled')
        if (settled[0]!.status === 'fulfilled') {
          expect(live.map((x) => x.contact_id)).toEqual([s.id])
          tally.createThenMerge++
        } else {
          expect(code(settled[0] as PromiseRejectedResult)).toBe('invalid_reference')
          tally.mergeThenRefused++
        }
      } else {
        const conflicted = settled.some((x) => x.status === 'rejected' && code(x) === 'conflict')
        if (conflicted) tally.conflict++
        else if (settled[0]!.status === 'fulfilled') tally.createThenMerge++
        else tally.mergeThenRefused++
      }
    }
    console.log(`[concurrency] ${name} merge vs identity create: create then merge ${tally.createThenMerge}, merge then create refused ${tally.mergeThenRefused}, conflict ${tally.conflict} of ${TRIALS}`)
  })
})

// ---- administration (CORE40 D13): two revokes of one key --------------------------------------------------------
describe.each(['postgres', 'd1'] as const)('concurrent administration writes on %s', (name) => {
  let e: Engine
  const TRIALS = name === 'postgres' ? 20 : 5
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })

  it(`two revokes of one key end with exactly one api_key.revoked event (${TRIALS} trials)`, async () => {
    const tally = { bothOk: 0, conflict: 0 }
    for (let i = 0; i < TRIALS; i++) {
      await e.reset()
      const env = e.env({ now: T(0) })
      const key = (await e.run(issueApiKeyOperation(env, { agent_id: e.agentId }, await generateApiKey(env.randomBytes)))).value
      const settled = await together([
        () => mapped(e.run(revokeApiKeyOperation(e.env({ now: T(1) }), key.id))),
        () => mapped(e.run(revokeApiKeyOperation(e.env({ now: T(2) }), key.id))),
      ])
      for (const r of settled) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'conflict' })
      const ok = settled.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      expect(ok.length).toBeGreaterThanOrEqual(1)
      const revoked = (await e.rows('events')).filter((x) => x.type === 'api_key.revoked')
      expect(revoked).toHaveLength(1)
      const [stored] = await e.rows('api_keys')
      expect(stored!.revoked_at).not.toBeNull()
      expect(stored!.revoked_at).toBe(stored!.updated_at)
      expect(revoked[0]!.after).toMatchObject({ revoked_at: stored!.revoked_at, updated_at: stored!.updated_at })
      // Every success answers the one revocation that happened, whoever won.
      for (const r of ok) expect(r.value.value).toMatchObject({ revoked_at: stored!.revoked_at })
      if (name === 'postgres') {
        // The writer lock serialises the units: the second sees the revoked key and returns it unchanged.
        expect(ok).toHaveLength(2)
        expect(ok[0]!.value.value.revoked_at).toBe(ok[1]!.value.value.revoked_at)
      }
      ok.length === 2 ? tally.bothOk++ : tally.conflict++
    }
    console.log(`[concurrency] ${name} double revoke: both 200 ${tally.bothOk}, one conflicted ${tally.conflict} of ${TRIALS}`)
  })
})
