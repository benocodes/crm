import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openRailKit, TEST_OPS, type RailKit } from '../test/rail-kit.js'
import type { Actor } from '../test/action-kit.js'
import { PERMANENT_CODES } from './transport.js'

// [[AGT8]] D13, D14, D28, D50, D52, D53, D56: the runner over the fake transport. One `run` is one attempt: claim (lease and token), the dispatch stamp,
// the transport call outside any unit, then a finish or a retry schedule under the same lease token. Time is the kit's injected clock.
let k: RailKit
let owner: Actor
let writer: Actor
let proposer: Actor
const T0 = new Date('2026-11-06T10:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
beforeAll(async () => {
  k = await openRailKit({ now: T0 })
})
afterAll(() => k.close())
beforeEach(async () => {
  k.setNow(T0)
  await k.reset()
  k.setNow(T0)
  owner = k.owner
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write', 'action_requests:read'])
  proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'action_requests:read'])
})
const AR = '/api/v1/action-requests'
let n = 0
/** A direct enqueue (the runner is not started: the tests drive it). */
const enqueue = async (op: keyof typeof TEST_OPS = 'reconcile', args: Record<string, unknown> = {}): Promise<string> => {
  const r = await k.enqueue(writer, { text: 'x', ...args, idempotency_key: `k${++n}` }, op)
  expect(r.status).toBe(202)
  return r.body.id
}
/** A proposal approved by the writer: an execution linked to a request, authorised by the writer, created by the proposer. */
const approved = async (args: Record<string, unknown> = {}): Promise<{ requestId: string; id: string }> => {
  const requestId = (await k.call(proposer, 'POST', AR, { operation: TEST_OPS.reconcile, arguments: { text: 'x', ...args }, reason: 'r' })).body.id as string
  const r = await k.call(writer, 'POST', `${AR}/${requestId}/approve`)
  expect(r.status).toBe(200)
  return { requestId, id: r.body.execution_id }
}
const row = (id: string) => k.exec(id)
const request = async (id: string) => (await k.rows('action_requests', 'id = ?', id))[0]!
const ev = async (type: string) => k.events(type)
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(cond()).toBe(true)
}
const SECONDS = (iso: unknown, from: Date = T0) => (Date.parse(iso as string) - from.getTime()) / 1000

describe('the happy path and the machinery (D53, D56)', () => {
  it('sent first time: done with the transport result, one dispatch, created and completed events', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'sent', result: { message_id: 'm-1' } })
    k.setNow(at(1))
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(k.transport.dispatches).toHaveLength(1)
    expect(k.transport.dispatches[0]).toMatchObject({ executionId: id, operation: TEST_OPS.reconcile, arguments: { text: 'x' }, resolution: { anchor: 'anchor-1' }, attempt: 1 })
    expect(k.transport.dispatches[0]!.clientRef).toBe(`${id}@test.invalid`)
    expect(await row(id)).toMatchObject({ status: 'done', result: { message_id: 'm-1' }, attempts: 1, error_code: null, lease_token: null, lease_until: null, done_at: at(1).toISOString() })
    expect(await ev('action_execution.created')).toHaveLength(1)
    const completed = await ev('action_execution.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ actor_id: writer.id, resource_id: id })
    expect((completed[0]!.after as any).status).toBe('done')
    expect(JSON.stringify(completed[0])).not.toContain('lease_token')
  })

  it('claim, stamp and retry scheduling are machinery: no event and the execution keeps its updated_at', async () => {
    const id = await enqueue()
    const created = await row(id)
    const eventsBefore = (await k.events()).length
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable' })
    k.setNow(at(1))
    expect(await k.run(id)).toMatchObject({ outcome: 'retry' })
    const r = await row(id)
    expect(r).toMatchObject({ status: 'queued', attempts: 1, dispatched_at: null, last_error_code: 'retryable', lease_token: null, lease_until: null })
    expect(r.updated_at).toBe(created.updated_at)
    expect((await k.events()).length).toBe(eventsBefore)
  })

  it('a run before the execution is due claims nothing and dispatches nothing', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable' })
    await k.run(id)
    k.setNow(at(59))
    expect(await k.run(id)).toMatchObject({ outcome: 'skipped' })
    expect(k.transport.dispatches).toHaveLength(1)
    expect((await row(id)).attempts).toBe(1)
  })

  it('an unknown execution id is skipped', async () => {
    expect(await k.run('00000000-0000-7000-8000-000000000000')).toMatchObject({ outcome: 'skipped' })
  })
})

describe('lease and stale finisher (D28)', () => {
  it('two runs racing: one claims and dispatches, the other is skipped while the first is mid-dispatch', async () => {
    const id = await enqueue()
    const hold = k.transport.hold('dispatch')
    const a = k.run(id)
    await hold.reached
    const b = await k.run(id)
    expect(b).toMatchObject({ outcome: 'skipped' })
    hold.release({ kind: 'sent' })
    expect(await a).toMatchObject({ outcome: 'done' })
    expect(k.transport.dispatches).toHaveLength(1)
    expect(await ev('action_execution.completed')).toHaveLength(1)
  })

  it('two simultaneous runs: exactly one claim wins', async () => {
    const id = await enqueue()
    const outcomes = await Promise.all([k.run(id), k.run(id)])
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['done', 'skipped'])
    expect(k.transport.dispatches).toHaveLength(1)
  })

  it('a runner whose lease expired and was re-claimed cannot finish: its finish writes nothing, the newer lease finishes', async () => {
    const { requestId, id } = await approved()
    const holdA = k.transport.hold('dispatch')
    const a = k.run(id)
    await holdA.reached
    expect((await row(id)).status).toBe('claimed')
    // The lease (60 s) lapses; a second runner claims, finds the first one's dispatch stamp, and reconciles: it is still in flight when A answers.
    k.setNow(at(61))
    const holdB = k.transport.hold('reconcile')
    const b = k.run(id)
    await holdB.reached
    holdA.release({ kind: 'sent', result: { from: 'A' } })
    expect(await a).toMatchObject({ outcome: 'skipped' })
    // A's finish wrote nothing: not the execution, not the request, no event.
    expect((await row(id)).status).toBe('claimed')
    expect((await request(requestId)).status).toBe('approved')
    expect(await ev('action_execution.completed')).toEqual([])
    expect(await ev('action_request.executed')).toEqual([])
    holdB.release({ kind: 'found', result: { from: 'B' } })
    expect(await b).toMatchObject({ outcome: 'done' })
    expect(await row(id)).toMatchObject({ status: 'done', result: { from: 'B' }, attempts: 2 })
    expect((await request(requestId)).status).toBe('executed')
    expect(await ev('action_execution.completed')).toHaveLength(1)
    expect(k.transport.dispatches).toHaveLength(1)
  })

  it('a crash after the dispatch stamp is recovered by the cron once the lease lapses, by reconciling, with no second dispatch', async () => {
    const id = await enqueue()
    const hold = k.transport.hold('dispatch')
    const crashed = k.run(id)
    await hold.reached
    expect((await row(id)).dispatched_at).not.toBeNull()
    // Before the lease lapses the tick finds nothing due.
    k.setNow(at(30))
    expect(await k.tick()).toMatchObject({ attempted: 0 })
    k.setNow(at(61))
    k.transport.willReconcile({ kind: 'found', result: { recovered: true } })
    expect(await k.tick()).toMatchObject({ attempted: 1 })
    expect(await row(id)).toMatchObject({ status: 'done', result: { recovered: true } })
    expect(k.transport.dispatches).toHaveLength(1)
    expect(k.transport.reconciles).toHaveLength(1)
    hold.release({ kind: 'sent' })
    await crashed
    expect(await ev('action_execution.completed')).toHaveLength(1)
  })

  it('a crash before the dispatch stamp is recovered by dispatching: the stamp is what decides', async () => {
    const id = await enqueue()
    // A claim whose runner died before anything else: claimed, lease running, never stamped.
    await k.d1.prepare(`update action_executions set status = 'claimed', attempts = 1, lease_token = 'dead', lease_until = ? where id = ?`).bind(at(60).toISOString(), id).run()
    k.setNow(at(30))
    expect(await k.run(id)).toMatchObject({ outcome: 'skipped' })
    k.setNow(at(61))
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(k.transport.dispatches).toHaveLength(1)
    expect(k.transport.reconciles).toHaveLength(0)
    expect((await row(id)).attempts).toBe(2)
  })
})

describe('retry policy matrix (D53)', () => {
  const next = async (id: string) => SECONDS((await row(id)).next_attempt_at as string, k.now())

  it.each([
    ['no retry_after: the 60 s floor beats the 30 s backoff', undefined, 60],
    ['a retry_after shorter than the backoff: the 30 s backoff', 10_000, 30],
    ['a longer retry_after is honoured', 120_000, 120],
  ])('retryable at attempt 1, %s', async (_name, retryAfterMs, seconds) => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
    k.setNow(at(0))
    await k.run(id)
    expect(await next(id)).toBe(seconds)
  })

  it('retryable then sent: the second attempt waits for its time and then finishes', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable' }, { kind: 'sent' })
    await k.run(id)
    k.setNow(at(59))
    expect(await k.run(id)).toMatchObject({ outcome: 'skipped' })
    k.setNow(at(60))
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(k.transport.dispatches.map((d) => d.attempt)).toEqual([1, 2])
    expect(new Set(k.transport.dispatches.map((d) => d.clientRef)).size).toBe(1)
  })

  it('the backoff is 30 * 2^(n-1) seconds from the attempt (n = 3: 120 s) when no floor applies', async () => {
    const id = await enqueue()
    k.transport.willDispatch(...Array.from({ length: 3 }, () => ({ kind: 'not_sent', code: 'retryable', retryAfterMs: 1 }) as const))
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      k.setNow(new Date(Date.parse((await row(id)).next_attempt_at as string)))
      await k.run(id)
      waits.push(await next(id))
    }
    expect(waits).toEqual([30, 60, 120])
  })

  it('a throttle (retryable, no retry_after) waits at least 60 s whatever the attempt', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable' }, { kind: 'not_sent', code: 'retryable' })
    await k.run(id)
    k.setNow(at(60))
    await k.run(id)
    expect(await next(id)).toBeGreaterThanOrEqual(60)
  })

  describe('an unknown outcome under reconcile', () => {
    it('reconcile found: done with no second dispatch', async () => {
      const id = await enqueue()
      k.transport.willDispatch({ kind: 'unknown' })
      k.transport.willReconcile({ kind: 'found', result: { message_id: 'found' } })
      await k.run(id)
      expect(await row(id)).toMatchObject({ status: 'queued', attempts: 1 })
      expect((await row(id)).dispatched_at).not.toBeNull()
      k.setNow(at(30))
      expect(await k.run(id)).toMatchObject({ outcome: 'done' })
      expect(await row(id)).toMatchObject({ status: 'done', result: { message_id: 'found' } })
      expect(k.transport.dispatches).toHaveLength(1)
      expect(k.transport.reconciles).toHaveLength(1)
    })
    it('reconcile not_found: the next attempt dispatches again', async () => {
      const id = await enqueue()
      k.transport.willDispatch({ kind: 'unknown' }, { kind: 'sent' })
      k.transport.willReconcile({ kind: 'not_found' })
      await k.run(id)
      k.setNow(at(30))
      expect(await k.run(id)).toMatchObject({ outcome: 'done' })
      expect(k.transport.dispatches).toHaveLength(2)
      expect(k.transport.reconciles).toHaveLength(1)
    })
    it('reconcile unknown: it waits, with no second dispatch', async () => {
      const id = await enqueue()
      k.transport.willDispatch({ kind: 'unknown' })
      k.transport.willReconcile({ kind: 'unknown' })
      await k.run(id)
      k.setNow(at(30))
      expect(await k.run(id)).toMatchObject({ outcome: 'retry' })
      expect(await row(id)).toMatchObject({ status: 'queued', attempts: 2 })
      expect(await next(id)).toBe(60)
      expect(k.transport.dispatches).toHaveLength(1)
      expect(k.transport.reconciles).toHaveLength(1)
    })
    it('a transport that throws on dispatch is an unknown outcome: the next attempt reconciles', async () => {
      const id = await enqueue()
      k.transport.willDispatch({ kind: 'throw' })
      k.transport.willReconcile({ kind: 'found', result: { ok: true } })
      expect(await k.run(id)).toMatchObject({ outcome: 'retry' })
      k.setNow(at(30))
      expect(await k.run(id)).toMatchObject({ outcome: 'done' })
      expect(k.transport.dispatches).toHaveLength(1)
    })
    it('a transport with no reconcile is treated as unknown: the execution waits and never dispatches twice', async () => {
      const id = await enqueue()
      k.transport.canReconcile = false
      k.transport.willDispatch({ kind: 'unknown' })
      await k.run(id)
      k.setNow(at(30))
      expect(await k.run(id)).toMatchObject({ outcome: 'retry' })
      expect(k.transport.dispatches).toHaveLength(1)
    })
  })

  it('an unknown outcome under idempotent: the next attempt dispatches again, with no reconcile', async () => {
    const id = await enqueue('idempotent')
    k.transport.willDispatch({ kind: 'unknown' }, { kind: 'sent' })
    await k.run(id)
    k.setNow(at(30))
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(k.transport.dispatches).toHaveLength(2)
    expect(k.transport.reconciles).toHaveLength(0)
  })

  it('an unknown outcome under never: outcome_unknown at once, no retry, no reconcile', async () => {
    const id = await enqueue('never')
    k.transport.willDispatch({ kind: 'unknown' })
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'outcome_unknown' })
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'outcome_unknown' })
    expect(k.transport.dispatches).toHaveLength(1)
    expect(k.transport.reconciles).toHaveLength(0)
  })

  it('a crash recovered under never: outcome_unknown at once instead of a second dispatch', async () => {
    const id = await enqueue('never')
    const hold = k.transport.hold('dispatch')
    const crashed = k.run(id)
    await hold.reached
    k.setNow(at(61))
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'outcome_unknown' })
    expect(k.transport.dispatches).toHaveLength(1)
    hold.release({ kind: 'sent' })
    await crashed
    expect((await row(id)).error_code).toBe('outcome_unknown')
  })

  it('a definite not_sent clears dispatched_at, so the next attempt does not reconcile', async () => {
    const id = await enqueue()
    // attempt 1: unknown (stamp kept); attempt 2: reconcile says not_found, dispatch says not_sent (stamp cleared); attempt 3 dispatches without reconciling.
    k.transport.willDispatch({ kind: 'unknown' }, { kind: 'not_sent', code: 'retryable' }, { kind: 'sent' })
    k.transport.willReconcile({ kind: 'not_found' })
    await k.run(id)
    k.setNow(at(30))
    await k.run(id)
    expect((await row(id)).dispatched_at).toBeNull()
    expect(k.transport.reconciles).toHaveLength(1)
    k.setNow(new Date(Date.parse((await row(id)).next_attempt_at as string)))
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(k.transport.dispatches).toHaveLength(3)
    expect(k.transport.reconciles).toHaveLength(1)
  })
})

describe('terminal classifications (D14, D53)', () => {
  it.each(PERMANENT_CODES)('a permanent %s fails at once with that code and never retries', async (permanent) => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: permanent, message: 'RAW-PROVIDER-TEXT token=abc123' })
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: permanent })
    const r = await row(id)
    expect(r).toMatchObject({ status: 'failed', error_code: permanent })
    expect(typeof r.error_message).toBe('string')
    expect(JSON.stringify(r)).not.toContain('RAW-PROVIDER-TEXT')
    expect(JSON.stringify(await ev('action_execution.failed'))).not.toContain('RAW-PROVIDER-TEXT')
    expect((await ev('action_execution.failed')).map((e) => e.actor_id)).toEqual([writer.id])
    expect(await ev('action_execution.completed')).toEqual([])
    expect(k.transport.dispatches).toHaveLength(1)
  })

  it('attempts_exhausted after five definite not_sent attempts', async () => {
    const id = await enqueue()
    k.transport.willDispatch(...Array.from({ length: 6 }, () => ({ kind: 'not_sent', code: 'retryable', retryAfterMs: 1 }) as const))
    let last: Awaited<ReturnType<RailKit['run']>> | undefined
    for (let i = 0; i < 5; i++) {
      k.setNow(new Date(Math.max(k.now().getTime(), Date.parse((await row(id)).next_attempt_at as string))))
      last = await k.run(id)
    }
    expect(last).toMatchObject({ outcome: 'failed', code: 'attempts_exhausted' })
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'attempts_exhausted', attempts: 5 })
    expect(k.transport.dispatches).toHaveLength(5)
  })

  it('five unknown outcomes under reconcile end as outcome_unknown, not attempts_exhausted, after reconciling', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'unknown' })
    for (let i = 0; i < 5; i++) {
      k.setNow(new Date(Math.max(k.now().getTime(), Date.parse((await row(id)).next_attempt_at as string))))
      await k.run(id)
      if ((await row(id)).status === 'failed') break
    }
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'outcome_unknown' })
    expect(k.transport.dispatches).toHaveLength(1)
    expect(k.transport.reconciles.length).toBeGreaterThanOrEqual(1)
  })

  it('a never-dispatched execution whose next attempt passes the deadline fails deadline_passed at once', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable', retryAfterMs: 20 * 60_000 })
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'deadline_passed' })
    expect((await row(id)).status).toBe('failed')
    expect(k.transport.dispatches).toHaveLength(1)
  })

  it('an execution first run after its deadline fails deadline_passed with no dispatch', async () => {
    const id = await enqueue()
    k.setNow(at(11 * 60))
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'deadline_passed' })
    expect(k.transport.dispatches).toHaveLength(0)
  })

  it('a maybe-dispatched execution at its deadline gets exactly one final reconcile, then outcome_unknown', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'unknown' })
    await k.run(id)
    k.setNow(at(11 * 60))
    k.transport.willReconcile({ kind: 'unknown' })
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'outcome_unknown' })
    expect(k.transport.reconciles).toHaveLength(1)
    expect(k.transport.dispatches).toHaveLength(1)
  })

  it('the final reconcile can still find the message: done, not failed', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'unknown' })
    await k.run(id)
    k.setNow(at(11 * 60))
    k.transport.willReconcile({ kind: 'found', result: { late: true } })
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(await row(id)).toMatchObject({ status: 'done', result: { late: true } })
  })

  it('an unknown outcome whose retry would pass the deadline gets the final reconcile now', async () => {
    const id = await enqueue()
    k.setNow(at(590))
    k.transport.willDispatch({ kind: 'unknown' })
    k.transport.willReconcile({ kind: 'unknown' })
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'outcome_unknown' })
    expect(k.transport.reconciles).toHaveLength(1)
  })

  it('an operation no longer registered fails the execution instead of looping', async () => {
    const id = await enqueue()
    await k.d1.prepare(`update action_executions set operation = 'gone.operation' where id = ?`).bind(id).run()
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'provider_rejected' })
  })
})

describe('finish atomicity and attribution (D50, D56, invariant 5)', () => {
  it('an approved execution finishes as one unit attributed to the approver: execution, request and both events', async () => {
    const { requestId, id } = await approved()
    k.transport.willDispatch({ kind: 'sent', result: { message_id: 'm' } })
    k.setNow(at(1))
    expect(await k.run(id)).toMatchObject({ outcome: 'done' })
    expect(await request(requestId)).toMatchObject({ status: 'executed', executed_at: at(1).toISOString(), result: { message_id: 'm' }, decided_by: writer.id, error_code: null })
    const completed = await ev('action_execution.completed')
    const executed = await ev('action_request.executed')
    expect(completed.map((e) => e.actor_id)).toEqual([writer.id])
    expect(executed.map((e) => e.actor_id)).toEqual([writer.id])
    expect(executed[0]).toMatchObject({ resource_id: requestId })
    expect((executed[0]!.before as any).status).toBe('approved')
    expect((executed[0]!.after as any).status).toBe('executed')
    // The proposer is attributed only to the creation of the request, never to a finish.
    expect([...completed, ...executed].some((e) => e.actor_id === proposer.id)).toBe(false)
  })

  it('a failed approved execution mirrors failed on the request with the same error and keeps its decision', async () => {
    const { requestId, id } = await approved()
    const before = await request(requestId)
    k.transport.willDispatch({ kind: 'not_sent', code: 'permission_missing' })
    k.setNow(at(1))
    expect(await k.run(id)).toMatchObject({ outcome: 'failed', code: 'permission_missing' })
    const exec = await row(id)
    const req = await request(requestId)
    expect(req).toMatchObject({ status: 'failed', error_code: 'permission_missing', error_message: exec.error_message, decided_by: before.decided_by, decided_at: before.decided_at, executed_at: null })
    const failed = await ev('action_request.failed')
    expect(failed.map((e) => [e.actor_id, e.resource_id])).toEqual([[writer.id, requestId]])
    expect(await ev('action_execution.failed')).toHaveLength(1)
    expect(await ev('action_request.executed')).toEqual([])
  })

  it('a direct execution has no request and still emits created and completed', async () => {
    const id = await enqueue()
    await k.run(id)
    expect((await ev('action_execution.created')).length).toBe(1)
    expect((await ev('action_execution.completed')).length).toBe(1)
    expect(await ev('action_request.executed')).toEqual([])
    expect((await row(id)).action_request_id).toBeNull()
  })
})

describe('sweeps (D54)', () => {
  it('the runner sweep takes at most five due or lease-expired executions per tick, oldest first', async () => {
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      k.setNow(at(i))
      ids.push(await enqueue())
    }
    k.setNow(at(100))
    expect(await k.runDue()).toEqual({ attempted: 5 })
    const statuses = await Promise.all(ids.map(async (id) => (await row(id)).status))
    expect(statuses).toEqual(['done', 'done', 'done', 'done', 'done', 'queued', 'queued'])
    expect(await k.runDue()).toEqual({ attempted: 2 })
  })

  it('the tick runs the expiry sweep and then the runner sweep, each bounded', async () => {
    const id = await enqueue()
    const r = await k.tick()
    expect(r).toEqual({ expired: 0, attempted: 1 })
    expect((await row(id)).status).toBe('done')
  })

  it('an execution that is not due (waiting out a backoff) is not swept', async () => {
    const id = await enqueue()
    k.transport.willDispatch({ kind: 'not_sent', code: 'retryable' })
    await k.run(id)
    k.setNow(at(30))
    expect(await k.runDue()).toEqual({ attempted: 0 })
  })
})
