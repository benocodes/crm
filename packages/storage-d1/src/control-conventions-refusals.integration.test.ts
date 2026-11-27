import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE683]] D9, P3 ([[CORE679]] row 679.32): the control database's short id CHECK (length and hex only, no dash positions)
// became the canonical one. A 36-character lower-case hex value with a dash out of place passed the short form; it is refused now.
// Raw inserts are the permitted exception: this proves what the database refuses, which no operation reaches.
const uid = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const AT = '2026-11-27T09:00:00.000Z'
// 36 characters, lower-case hex and dashes only, but the dash sits at position 10, not 9: the short form accepted it.
const MISPLACED = '0190b2c40-000-7000-8000-000000000001'
const SUB = uid(100)
const NO_SUCH_SUB = uid(101)

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONTROL'], { control: ['CONTROL'] })
  d1 = local.bindings.CONTROL!
})
afterAll(() => local.dispose())

const run = (sqlText: string, ...binds: unknown[]) =>
  d1.batch([d1.prepare(sqlText).bind(...binds)]).then(
    () => null,
    (e: Error) => e.message,
  )
const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  return run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...Object.values(row),
  )
}

let seq = 1000
const next = () => uid(seq++)
// A valid row per table; `id`-like values are minted fresh each time so a refusal can only be the column under test.
const rows: Record<string, () => Record<string, unknown> | Promise<Record<string, unknown>>> = {
  invitations: () => ({
    id: next(),
    organization_id: uid(1),
    email: `a${seq}@example.com`,
    role: 'member',
    token_hash: `${seq}`.padEnd(64, '0'),
    expires_at: AT,
    created_by: uid(2),
    created_at: AT,
  }),
  control_audit: () => ({
    id: next(),
    at: AT,
    actor_id: uid(2),
    action: 'x',
    target_type: 't',
    target_id: 'any',
    detail: '{}',
  }),
  webhook_subscriptions: () => ({
    id: next(),
    created_at: AT,
    updated_at: AT,
    organization_id: uid(1),
    created_by: uid(2),
    agent_id: uid(3),
    url: 'https://example.com/h',
    event_types: '["contact.created"]',
    status: 'active',
  }),
  webhook_secrets: () => ({
    id: next(),
    created_at: AT,
    organization_id: uid(1),
    created_by: uid(2),
    subscription_id: SUB,
    sealed: 's',
    key_version: 1,
  }),
  // its key is the subscription it belongs to: a fresh subscription per row (the primary key is that column)
  webhook_dispatch_state: async () => {
    const subscription_id = next()
    expect(await insert('webhook_subscriptions', { ...rows.webhook_subscriptions!(), id: subscription_id })).toBeNull()
    return { subscription_id, created_at: AT, organization_id: uid(1), created_by: uid(2), cursor_event_id: uid(5) }
  },
  webhook_deliveries: () => ({
    id: next(),
    created_at: AT,
    organization_id: uid(1),
    created_by: uid(2),
    subscription_id: SUB,
    event_id: next(),
    event_type: 'contact.created',
    status: 'pending',
    next_attempt_at: AT,
  }),
  api_keys: () => ({
    id: next(),
    created_at: AT,
    updated_at: AT,
    organization_id: uid(1),
    agent_id: uid(3),
    key_hash: `${seq}`,
    prefix: 'vb_',
    created_by: uid(2),
  }),
}

// Columns that had the short form (or none) before and must now carry the canonical id CHECK, named <table>_<column>_uuid.
const CHECKED: Record<string, string[]> = {
  invitations: ['id', 'organization_id', 'created_by'],
  control_audit: ['id', 'actor_id'],
  webhook_subscriptions: ['id', 'organization_id', 'created_by', 'agent_id'],
  webhook_secrets: ['id', 'organization_id', 'created_by'],
  webhook_dispatch_state: ['organization_id', 'created_by', 'cursor_event_id'],
  webhook_deliveries: ['id', 'organization_id', 'created_by', 'event_id'],
  api_keys: ['id', 'organization_id', 'agent_id', 'created_by'],
}

describe('the control database refuses a misplaced dash in every id column (P3)', () => {
  beforeAll(async () => {
    expect(await insert('webhook_subscriptions', { ...(await rows.webhook_subscriptions!()), id: SUB })).toBeNull()
  })

  it('accepts a well-formed row of every table (the fixtures are valid)', async () => {
    for (const [table, row] of Object.entries(rows)) expect(await insert(table, await row()), table).toBeNull()
  })

  for (const [table, columns] of Object.entries(CHECKED))
    for (const column of columns)
      it(`${table}.${column} refuses a 36-character hex value with a dash out of place, by name`, async () => {
        const message = await insert(table, { ...(await rows[table]!()), [column]: MISPLACED })
        expect(message ?? 'accepted', `${table}.${column}`).toContain(`${table}_${column}_uuid`)
      })

  it('control_audit.target_id stays free text (a Better Auth id is a target)', async () => {
    expect(await insert('control_audit', { ...(await rows.control_audit!()), target_id: 'ba_user_01' })).toBeNull()
  })

  it('a keyed column refuses a value that is not a key (webhook_secrets/webhook_deliveries/webhook_dispatch_state.subscription_id)', async () => {
    for (const table of ['webhook_secrets', 'webhook_deliveries'])
      expect(await insert(table, { ...(await rows[table]!()), subscription_id: NO_SUCH_SUB }), table).toMatch(
        /FOREIGN KEY constraint failed/i,
      )
    expect(
      await insert('webhook_dispatch_state', {
        ...(await rows.webhook_dispatch_state!()),
        subscription_id: NO_SUCH_SUB,
      }),
    ).toMatch(/FOREIGN KEY constraint failed/i)
    expect(
      await insert('webhook_dispatch_state', { ...(await rows.webhook_dispatch_state!()), subscription_id: MISPLACED }),
    ).toMatch(/FOREIGN KEY constraint failed/i)
  })
})
