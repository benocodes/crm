import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// AGT8 cycle 2 (D11, D48, D51, D56, D59): what `action_executions` in genesis refuses and keeps (a request among the seeded rows). The raw inserts are the permitted exception: the schema test proves what the database refuses, which no operation reaches.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-11-06T09:00:00.000Z'
const LATER = '2026-11-06T09:10:00.000Z'
const id = (n: number) => `0190b2c4-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`
const HASH = 'a'.repeat(64)

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'])
  d1 = local.bindings.G!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: USER, kind: 'user' })
  await seedPrincipal(d1, { id: AGENT, kind: 'agent' })
  expect(
    await insert('action_requests', {
      id: id(1),
      organization_id: ORG,
      created_by: USER,
      created_at: AT,
      updated_at: AT,
      operation: 'tasks.create',
      arguments: '{"title":"t"}',
      status: 'approved',
      reason: 'r',
      evidence: '[]',
      expires_at: LATER,
      decided_by: AGENT,
      decided_at: AT,
    }),
  ).toBeNull()
})
afterAll(async () => {
  await local.dispose()
})

const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return d1
    .batch([
      d1
        .prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
        .bind(...Object.values(row)),
    ])
    .then(
      () => null,
      (e: Error) => e.message,
    )
}
const run = (sqlText: string, ...binds: unknown[]) =>
  d1
    .prepare(sqlText)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )
const all = async <T = Record<string, unknown>>(sqlText: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(sqlText)
      .bind(...binds)
      .all()
  ).results ?? []) as T[]
const base = { organization_id: ORG, created_by: USER, authorised_by: USER, created_at: AT, updated_at: AT }
let n = 100
const eid = (k: number) => `0190b2c4-0000-7000-8000-0000000e${String(k).padStart(4, '0')}`
/** A queued execution; every call gets its own id and client_ref. */
const exec = (over: Record<string, unknown> = {}) => {
  n++
  return {
    id: eid(n),
    ...base,
    operation: 'test.enqueue',
    arguments: '{"text":"x"}',
    resolution: '{}',
    status: 'queued',
    client_ref: `${eid(n)}@test.invalid`,
    input_hash: HASH,
    deadline_at: LATER,
    next_attempt_at: AT,
    ...over,
  }
}
const claimed = { status: 'claimed', lease_token: 'tok', lease_until: LATER, attempts: 1 }
const done = { status: 'done', done_at: LATER, result: '{"ok":true}' }
const failed = { status: 'failed', done_at: LATER, error_code: 'provider_rejected' }

describe('action_executions', () => {
  it('the status CHECK admits the four statuses and refuses any other', async () => {
    expect(await insert('action_executions', exec({ status: 'paused' }))).toMatch(/action_executions_status/)
    expect(await insert('action_executions', exec())).toBeNull()
    expect(await insert('action_executions', exec(claimed))).toBeNull()
    expect(await insert('action_executions', exec(done))).toBeNull()
    expect(await insert('action_executions', exec(failed))).toBeNull()
  })

  it('done needs a result, failed needs an error_code, and only a finished execution has done_at', async () => {
    expect(await insert('action_executions', exec({ status: 'done', done_at: LATER }))).toMatch(
      /action_executions_done/,
    )
    expect(await insert('action_executions', exec({ status: 'failed', done_at: LATER }))).toMatch(
      /action_executions_failed/,
    )
    expect(await insert('action_executions', exec({ status: 'done', result: '{}' }))).toMatch(
      /action_executions_finished/,
    )
    expect(await insert('action_executions', exec({ done_at: LATER }))).toMatch(/action_executions_finished/)
    expect(await insert('action_executions', exec({ ...done, error_code: 'x' }))).toMatch(/action_executions_outcome/)
    expect(await insert('action_executions', exec({ ...failed, result: '{}' }))).toMatch(/action_executions_outcome/)
  })

  it('a lease exists exactly while the execution is claimed', async () => {
    expect(await insert('action_executions', exec({ status: 'claimed' }))).toMatch(/action_executions_lease/)
    expect(await insert('action_executions', exec({ status: 'claimed', lease_token: 'tok' }))).toMatch(
      /action_executions_lease/,
    )
    expect(await insert('action_executions', exec({ lease_token: 'tok', lease_until: LATER }))).toMatch(
      /action_executions_lease/,
    )
    expect(await insert('action_executions', exec({ ...done, lease_token: 'tok', lease_until: LATER }))).toMatch(
      /action_executions_lease/,
    )
  })

  it('JSON columns, text bounds, the hash, attempts and ids are checked', async () => {
    expect(await insert('action_executions', exec({ arguments: 'nope' }))).toMatch(/action_executions_arguments/)
    expect(await insert('action_executions', exec({ arguments: '[1]' }))).toMatch(/action_executions_arguments/)
    expect(await insert('action_executions', exec({ resolution: '[1]' }))).toMatch(/action_executions_resolution/)
    expect(await insert('action_executions', exec({ ...done, result: 'nope' }))).toMatch(/action_executions_result/)
    expect(await insert('action_executions', exec({ operation: 'x' }))).toMatch(/action_executions_operation/)
    expect(await insert('action_executions', exec({ idempotency_key: '' }))).toMatch(
      /action_executions_idempotency_key/,
    )
    expect(await insert('action_executions', exec({ idempotency_key: 'k'.repeat(201) }))).toMatch(
      /action_executions_idempotency_key/,
    )
    expect(await insert('action_executions', exec({ input_hash: 'zz' }))).toMatch(/CHECK/)
    expect(await insert('action_executions', exec({ client_ref: 'a' }))).toMatch(/action_executions_client_ref/)
    expect(await insert('action_executions', exec({ attempts: -1 }))).toMatch(/CHECK/)
    expect(await insert('action_executions', exec({ id: 'x' }))).toMatch(/CHECK/)
    expect(await insert('action_executions', exec({ deadline_at: 'soon' }))).toMatch(/CHECK/)
    expect(await insert('action_executions', exec({ next_attempt_at: 'soon' }))).toMatch(/CHECK/)
  })

  it('an approved request has at most one execution (unique non-null action_request_id); executions without a request never collide', async () => {
    expect(await insert('action_executions', exec({ action_request_id: id(1) }))).toBeNull()
    expect(await insert('action_executions', exec({ action_request_id: id(1) }))).toMatch(/UNIQUE/)
    expect(await insert('action_executions', exec())).toBeNull()
    expect(await insert('action_executions', exec())).toBeNull()
  })

  it('an idempotency key is unique per (organisation, creator); another creator may reuse it; a null key never collides', async () => {
    expect(await insert('action_executions', exec({ idempotency_key: 'k' }))).toBeNull()
    expect(await insert('action_executions', exec({ idempotency_key: 'k' }))).toMatch(/UNIQUE/)
    expect(await insert('action_executions', exec({ idempotency_key: 'k', created_by: AGENT }))).toBeNull()
    expect(await insert('action_executions', exec({ idempotency_key: 'other' }))).toBeNull()
  })

  it('client_ref is unique', async () => {
    const first = exec()
    expect(await insert('action_executions', first)).toBeNull()
    expect(await insert('action_executions', exec({ client_ref: first.client_ref }))).toMatch(/UNIQUE/)
  })

  it('the foreign keys refuse a missing creator, authoriser or request', async () => {
    expect(await insert('action_executions', exec({ created_by: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_executions', exec({ authorised_by: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_executions', exec({ action_request_id: id(98) }))).toMatch(/FOREIGN KEY/)
    expect(await insert('action_executions', exec({ authorised_by: AGENT }))).toBeNull()
  })

  it('the update a finish makes is one the CHECKs admit, and one that leaves a lease behind is refused', async () => {
    const row = exec(claimed)
    expect(await insert('action_executions', row)).toBeNull()
    expect(
      await run("UPDATE action_executions SET status = 'done', done_at = ?, result = '{}' WHERE id = ?", LATER, row.id),
    ).toMatch(/action_executions_lease/)
    expect(
      await run(
        "UPDATE action_executions SET status = 'done', done_at = ?, result = '{}', lease_token = NULL, lease_until = NULL WHERE id = ?",
        LATER,
        row.id,
      ),
    ).toBeNull()
  })

  it('has the lookup and due indexes of the plan', async () => {
    const idx = (
      await all<{ name: string; unique: number; partial: number }>(
        "select name, \"unique\", partial from pragma_index_list('action_executions') where name like 'idx_%'",
      )
    )
      .map((r) => `${r.name}:${r.unique}:${r.partial}`)
      .sort()
    expect(idx).toEqual([
      'idx_action_executions_client_ref:1:0',
      'idx_action_executions_due:0:1',
      'idx_action_executions_idempotency:1:1',
      'idx_action_executions_lease:0:1',
      'idx_action_executions_organization_operation:0:0',
      'idx_action_executions_organization_status:0:0',
      'idx_action_executions_request:1:1',
    ])
  })
})
