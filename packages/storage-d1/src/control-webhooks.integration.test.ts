import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import {
  applyWebhookDispatchPage,
  claimWebhookDeliveries,
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  listDispatchableWebhooks,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  openControlDb,
  readWebhookSecrets,
  recordWebhookDeliveries,
  rotateWebhookSecret,
  updateWebhookSubscription,
  type NewWebhookSubscription,
} from './control-store.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE327]] groups 2 to 6 (P2 to P5): the control store's webhook reads and writes on a real control-plane D1 (Miniflare). `control_audit` refuses DELETE, so nothing is emptied between tests:
// every test makes its own agent and ids.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
const NOW = '2026-11-15T10:00:00.000Z'
const HOUR = 3_600_000
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString()
let local: LocalD1
let control: D1Like
beforeAll(async () => {
  local = await openLocalD1(['C'], { control: ['C'] })
  control = local.bindings.C!
})
afterAll(() => local.dispose())

let n = 0
const nextId = () => `0190b2c4-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`
const c = () => openControlDb(control)
const rows = async (text: string, ...binds: unknown[]) =>
  ((
    await control
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const run = (text: string, ...binds: unknown[]) =>
  control
    .prepare(text)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )
const audit = (targetId: string) => rows('select * from control_audit where target_id = ? order by id', targetId)
const count = async (table: string, column: string, value: string) =>
  Number((await rows(`select count(*) as n from ${table} where ${column} = ?`, value))[0]!.n)
const URL_SECRET = 'https://hooks.example.com/in/token123?key=s3cret'
const newSub = (over: Partial<NewWebhookSubscription> = {}): NewWebhookSubscription => ({
  id: nextId(),
  secretId: nextId(),
  auditId: nextId(),
  organizationId: ORG,
  actorId: ACTOR,
  agentId: nextId(),
  url: URL_SECRET,
  eventTypes: ['interaction.created'],
  sealed: 'SEALED-SECRET-VALUE',
  keyVersion: 1,
  cursorEventId: nextId(),
  maxLivePerAgent: 10,
  now: NOW,
  ...over,
})
const make = async (over: Partial<NewWebhookSubscription> = {}) => {
  const a = newSub(over)
  expect(await createWebhookSubscription(c(), a)).toBe('created')
  return a
}
const noLeak = (detail: unknown) => {
  const text = JSON.stringify(detail)
  for (const forbidden of ['SEALED', 'whsec_', 'token123', 's3cret', '/in/', '?key'])
    expect(text).not.toContain(forbidden)
}

describe('group 2: subscription writes carry their audit row in the same batch (P2, D9 (c), D12)', () => {
  it('create writes the subscription, its first secret, the dispatch state at the given cursor and exactly one webhook.created row', async () => {
    const a = await make()
    const sub = (await rows('select * from webhook_subscriptions where id = ?', a.id))[0]!
    expect(sub).toMatchObject({
      agent_id: a.agentId,
      status: 'active',
      deleted_at: null,
      created_by: ACTOR,
      created_at: NOW,
      updated_at: NOW,
    })
    expect(JSON.parse(sub.event_types)).toEqual(['interaction.created'])
    expect(
      await rows('select sealed, key_version, created_by from webhook_secrets where subscription_id = ?', a.id),
    ).toEqual([{ sealed: 'SEALED-SECRET-VALUE', key_version: 1, created_by: ACTOR }])
    expect(
      await rows(
        'select cursor_event_id, last_dispatched_at, last_success_at from webhook_dispatch_state where subscription_id = ?',
        a.id,
      ),
    ).toEqual([{ cursor_event_id: a.cursorEventId, last_dispatched_at: null, last_success_at: null }])
    const log = await audit(a.id)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      id: a.auditId,
      at: NOW,
      actor_id: ACTOR,
      action: 'webhook.created',
      target_type: 'webhook',
      target_id: a.id,
    })
    expect(JSON.parse(log[0]!.detail)).toEqual({
      agent_id: a.agentId,
      event_types: ['interaction.created'],
      status: 'active',
      url_origin: 'https://hooks.example.com',
    })
    noLeak(JSON.parse(log[0]!.detail))
  })

  it('update writes one webhook.updated row naming the changed fields and the new event_types, status and url_origin, never the URL', async () => {
    const a = await make()
    const later = plus(NOW, HOUR)
    expect(
      await updateWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
        url: 'https://other.example.org/p/secretpath?t=1',
        eventTypes: ['task.created', 'task.updated'],
        status: 'paused',
      }),
    ).toBe('updated')
    const sub = (await rows('select * from webhook_subscriptions where id = ?', a.id))[0]!
    expect(sub).toMatchObject({
      url: 'https://other.example.org/p/secretpath?t=1',
      status: 'paused',
      updated_at: later,
      created_at: NOW,
    })
    expect(JSON.parse(sub.event_types)).toEqual(['task.created', 'task.updated'])
    const log = (await audit(a.id)).filter((r) => r.action === 'webhook.updated')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ at: later, actor_id: ACTOR, target_type: 'webhook' })
    const detail = JSON.parse(log[0]!.detail)
    expect(detail).toEqual({
      changed: ['url', 'event_types', 'status'],
      event_types: ['task.created', 'task.updated'],
      status: 'paused',
      url_origin: 'https://other.example.org',
    })
    expect(JSON.stringify(detail)).not.toContain('secretpath')
  })

  it('an update of one field records only that field', async () => {
    const a = await make()
    await updateWebhookSubscription(c(), {
      id: a.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, HOUR),
      expectedUpdatedAt: NOW,
      status: 'paused',
    })
    const log = (await audit(a.id)).filter((r) => r.action === 'webhook.updated')
    expect(JSON.parse(log[0]!.detail)).toEqual({ changed: ['status'], status: 'paused' })
  })

  it('an update that changes nothing is a caller error, not a write', async () => {
    const a = await make()
    await expect(
      updateWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: plus(NOW, HOUR),
        expectedUpdatedAt: NOW,
      }),
    ).rejects.toThrow(/nothing to change/)
    expect(await audit(a.id)).toHaveLength(1)
  })

  it('delete sets deleted_at and keeps the row, with one webhook.deleted row holding the agent', async () => {
    const a = await make()
    const later = plus(NOW, HOUR)
    expect(
      await deleteWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
      }),
    ).toBe('deleted')
    expect((await rows('select deleted_at, updated_at from webhook_subscriptions where id = ?', a.id))[0]).toEqual({
      deleted_at: later,
      updated_at: later,
    })
    const log = (await audit(a.id)).filter((r) => r.action === 'webhook.deleted')
    expect(log).toHaveLength(1)
    expect(JSON.parse(log[0]!.detail)).toEqual({ agent_id: a.agentId })
  })

  it('rotate inserts a secret (never an update) with one webhook.secret_rotated row holding the new secret id', async () => {
    const a = await make()
    const secretId = nextId()
    expect(
      await rotateWebhookSecret(c(), {
        id: a.id,
        secretId,
        auditId: nextId(),
        actorId: ACTOR,
        sealed: 'SEALED-NEW',
        keyVersion: 2,
        now: plus(NOW, HOUR),
      }),
    ).toBe('rotated')
    expect(
      (
        await rows(
          'select id, sealed, key_version from webhook_secrets where subscription_id = ? order by created_at, id',
          a.id,
        )
      ).map((r) => r.sealed),
    ).toEqual(['SEALED-SECRET-VALUE', 'SEALED-NEW'])
    const log = (await audit(a.id)).filter((r) => r.action === 'webhook.secret_rotated')
    expect(log).toHaveLength(1)
    expect(JSON.parse(log[0]!.detail)).toEqual({ secret_id: secretId })
    noLeak(JSON.parse(log[0]!.detail))
    expect(JSON.stringify(log[0])).not.toContain('SEALED')
  })

  it.each(['create', 'update', 'delete', 'rotate'] as const)(
    'atomicity: a failing audit insert (a duplicate audit id) leaves nothing of the %s',
    async (kind) => {
      const dupAudit = nextId()
      expect(
        await run(
          "insert into control_audit (id, at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, 'x.y', 'x', 'x', '{}')",
          dupAudit,
          NOW,
          ACTOR,
        ),
      ).toBeNull()
      if (kind === 'create') {
        const a = newSub({ auditId: dupAudit })
        await expect(createWebhookSubscription(c(), a)).rejects.toThrow()
        for (const [t, col] of [
          ['webhook_subscriptions', 'id'],
          ['webhook_secrets', 'subscription_id'],
          ['webhook_dispatch_state', 'subscription_id'],
        ] as const)
          expect(await count(t, col, a.id), t).toBe(0)
        return
      }
      const a = await make()
      const later = plus(NOW, HOUR)
      if (kind === 'update')
        await expect(
          updateWebhookSubscription(c(), {
            id: a.id,
            auditId: dupAudit,
            actorId: ACTOR,
            now: later,
            expectedUpdatedAt: NOW,
            status: 'paused',
          }),
        ).rejects.toThrow()
      if (kind === 'delete')
        await expect(
          deleteWebhookSubscription(c(), {
            id: a.id,
            auditId: dupAudit,
            actorId: ACTOR,
            now: later,
            expectedUpdatedAt: NOW,
          }),
        ).rejects.toThrow()
      if (kind === 'rotate')
        await expect(
          rotateWebhookSecret(c(), {
            id: a.id,
            secretId: nextId(),
            auditId: dupAudit,
            actorId: ACTOR,
            sealed: 'S2',
            keyVersion: 1,
            now: later,
          }),
        ).rejects.toThrow()
      expect(
        (await rows('select status, deleted_at, updated_at from webhook_subscriptions where id = ?', a.id))[0],
      ).toEqual({ status: 'active', deleted_at: null, updated_at: NOW })
      expect(await count('webhook_secrets', 'subscription_id', a.id)).toBe(1)
      expect(await audit(a.id)).toHaveLength(1)
    },
  )
})

describe('group 3: guards write nothing, audit row included', () => {
  it('the per-agent live limit refuses the next create; a deleted subscription frees a place; the first create of an agent passes the limit over zero rows', async () => {
    const agentId = nextId()
    const first = await make({ agentId, maxLivePerAgent: 2 })
    await make({ agentId, maxLivePerAgent: 2 })
    const over = newSub({ agentId, maxLivePerAgent: 2 })
    expect(await createWebhookSubscription(c(), over)).toBe('limit')
    for (const [t, col] of [
      ['webhook_subscriptions', 'id'],
      ['webhook_secrets', 'subscription_id'],
      ['webhook_dispatch_state', 'subscription_id'],
    ] as const)
      expect(await count(t, col, over.id), t).toBe(0)
    expect(await audit(over.id)).toEqual([])
    expect(
      await deleteWebhookSubscription(c(), {
        id: first.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: plus(NOW, HOUR),
        expectedUpdatedAt: NOW,
      }),
    ).toBe('deleted')
    expect(await createWebhookSubscription(c(), over)).toBe('created')
  })

  it('another agent’s subscriptions do not count against the limit', async () => {
    await make({ maxLivePerAgent: 1 })
    expect(await createWebhookSubscription(c(), newSub({ maxLivePerAgent: 1 }))).toBe('created')
  })

  it('a write to a missing subscription is not_found and writes no audit row', async () => {
    const ghost = nextId()
    const later = plus(NOW, HOUR)
    expect(
      await updateWebhookSubscription(c(), {
        id: ghost,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
        status: 'paused',
      }),
    ).toBe('not_found')
    expect(
      await deleteWebhookSubscription(c(), {
        id: ghost,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
      }),
    ).toBe('not_found')
    expect(
      await rotateWebhookSecret(c(), {
        id: ghost,
        secretId: nextId(),
        auditId: nextId(),
        actorId: ACTOR,
        sealed: 'S',
        keyVersion: 1,
        now: later,
      }),
    ).toBe('not_found')
    expect(await audit(ghost)).toEqual([])
    expect(await count('webhook_secrets', 'subscription_id', ghost)).toBe(0)
  })

  it('a write to a deleted subscription is not_found and adds no audit row', async () => {
    const a = await make()
    const later = plus(NOW, HOUR)
    await deleteWebhookSubscription(c(), {
      id: a.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: later,
      expectedUpdatedAt: NOW,
    })
    const t = plus(NOW, 2 * HOUR)
    expect(
      await updateWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: t,
        expectedUpdatedAt: later,
        status: 'paused',
      }),
    ).toBe('not_found')
    expect(
      await deleteWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: t,
        expectedUpdatedAt: later,
      }),
    ).toBe('not_found')
    expect(
      await rotateWebhookSecret(c(), {
        id: a.id,
        secretId: nextId(),
        auditId: nextId(),
        actorId: ACTOR,
        sealed: 'S',
        keyVersion: 1,
        now: t,
      }),
    ).toBe('not_found')
    expect((await audit(a.id)).map((r) => r.action)).toEqual(['webhook.created', 'webhook.deleted'])
    expect(await count('webhook_secrets', 'subscription_id', a.id)).toBe(1)
  })

  it('an update or delete whose expected updated_at drifted is drifted and writes nothing', async () => {
    const a = await make()
    const stale = plus(NOW, -HOUR)
    const later = plus(NOW, HOUR)
    expect(
      await updateWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: stale,
        status: 'paused',
      }),
    ).toBe('drifted')
    expect(
      await deleteWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: stale,
      }),
    ).toBe('drifted')
    expect(
      (await rows('select status, deleted_at, updated_at from webhook_subscriptions where id = ?', a.id))[0],
    ).toEqual({ status: 'active', deleted_at: null, updated_at: NOW })
    expect(await audit(a.id)).toHaveLength(1)
  })

  it('an agent caller (ownerAgentId) cannot change another agent’s subscription: not_found, nothing written', async () => {
    const a = await make()
    const other = nextId()
    const later = plus(NOW, HOUR)
    expect(
      await updateWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
        status: 'paused',
        ownerAgentId: other,
      }),
    ).toBe('not_found')
    expect(
      await deleteWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
        ownerAgentId: other,
      }),
    ).toBe('not_found')
    expect(
      await rotateWebhookSecret(c(), {
        id: a.id,
        secretId: nextId(),
        auditId: nextId(),
        actorId: ACTOR,
        sealed: 'S',
        keyVersion: 1,
        now: later,
        ownerAgentId: other,
      }),
    ).toBe('not_found')
    expect(await audit(a.id)).toHaveLength(1)
    expect(
      await updateWebhookSubscription(c(), {
        id: a.id,
        auditId: nextId(),
        actorId: ACTOR,
        now: later,
        expectedUpdatedAt: NOW,
        status: 'paused',
        ownerAgentId: a.agentId,
      }),
    ).toBe('updated')
  })
})

describe('group 4: reads', () => {
  it('get: owner mode returns it, an agent sees only its own, a deleted or unknown id is null', async () => {
    const a = await make()
    const rec = await getWebhookSubscription(c(), { id: a.id })
    expect(rec).toEqual({
      id: a.id,
      organizationId: ORG,
      agentId: a.agentId,
      url: URL_SECRET,
      eventTypes: ['interaction.created'],
      status: 'active',
      createdBy: ACTOR,
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect((await getWebhookSubscription(c(), { id: a.id, ownerAgentId: a.agentId }))?.id).toBe(a.id)
    expect(await getWebhookSubscription(c(), { id: a.id, ownerAgentId: nextId() })).toBeNull()
    expect(await getWebhookSubscription(c(), { id: nextId() })).toBeNull()
    await deleteWebhookSubscription(c(), {
      id: a.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, HOUR),
      expectedUpdatedAt: NOW,
    })
    expect(await getWebhookSubscription(c(), { id: a.id })).toBeNull()
  })

  it('list: agent mode never returns another agent’s subscription, owner mode returns all, deleted rows are excluded, and it pages by id', async () => {
    const a = await make()
    const b = await make()
    const gone = await make({ agentId: a.agentId })
    await deleteWebhookSubscription(c(), {
      id: gone.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, HOUR),
      expectedUpdatedAt: NOW,
    })
    const asAgent = await listWebhookSubscriptions(c(), { ownerAgentId: a.agentId, limit: 50 })
    expect(asAgent.map((r) => r.id)).toEqual([a.id])
    const owner = (await listWebhookSubscriptions(c(), { limit: 500 })).map((r) => r.id)
    expect(owner).toEqual(expect.arrayContaining([a.id, b.id]))
    expect(owner).not.toContain(gone.id)
    expect(owner).toEqual([...owner].sort())
    expect((await listWebhookSubscriptions(c(), { agentId: b.agentId, limit: 50 })).map((r) => r.id)).toEqual([b.id])
    expect(await listWebhookSubscriptions(c(), { ownerAgentId: a.agentId, agentId: b.agentId, limit: 50 })).toEqual([])
    const page = await listWebhookSubscriptions(c(), { after: a.id, limit: 1 })
    expect(page).toHaveLength(1)
    expect(page[0]!.id > a.id).toBe(true)
  })

  it('list and get over nothing: empty', async () => {
    expect(await listWebhookSubscriptions(c(), { ownerAgentId: nextId(), limit: 10 })).toEqual([])
    expect(await listWebhookSubscriptions(c(), { agentId: nextId(), limit: 10 })).toEqual([])
  })

  it('secrets: all rows oldest first; with inForceAt, the newest plus the previous one only while the newest is under 24 hours old', async () => {
    const a = await make()
    const rotate = (sealed: string, now: string) =>
      rotateWebhookSecret(c(), {
        id: a.id,
        secretId: nextId(),
        auditId: nextId(),
        actorId: ACTOR,
        sealed,
        keyVersion: 1,
        now,
      })
    await rotate('S2', plus(NOW, 2 * HOUR))
    await rotate('S3', plus(NOW, 30 * HOUR))
    const sealedOf = (r: Array<{ sealed: string }>) => r.map((x) => x.sealed)
    expect(sealedOf(await readWebhookSecrets(c(), { subscriptionIds: [a.id] }))).toEqual([
      'SEALED-SECRET-VALUE',
      'S2',
      'S3',
    ])
    expect(
      sealedOf(await readWebhookSecrets(c(), { subscriptionIds: [a.id], inForceAt: plus(NOW, 31 * HOUR) })),
    ).toEqual(['S2', 'S3'])
    expect(
      sealedOf(await readWebhookSecrets(c(), { subscriptionIds: [a.id], inForceAt: plus(NOW, 54 * HOUR) })),
    ).toEqual(['S3'])
    const only = await make()
    expect(sealedOf(await readWebhookSecrets(c(), { subscriptionIds: [only.id], inForceAt: plus(NOW, HOUR) }))).toEqual(
      ['SEALED-SECRET-VALUE'],
    )
    expect(await readWebhookSecrets(c(), { subscriptionIds: [nextId()], inForceAt: NOW })).toEqual([])
    expect(await readWebhookSecrets(c(), { subscriptionIds: [] })).toEqual([])
  })

  it('dispatch eligibility: active, live subscriptions of the agents the caller names, with their cursor', async () => {
    const a = await make()
    const paused = await make({ agentId: a.agentId })
    await updateWebhookSubscription(c(), {
      id: paused.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, HOUR),
      expectedUpdatedAt: NOW,
      status: 'paused',
    })
    const deleted = await make({ agentId: a.agentId })
    await deleteWebhookSubscription(c(), {
      id: deleted.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, HOUR),
      expectedUpdatedAt: NOW,
    })
    const b = await make()
    const got = await listDispatchableWebhooks(c(), { organizationId: ORG, eligibleAgentIds: [a.agentId] })
    expect(got).toEqual([
      {
        subscriptionId: a.id,
        createdBy: ACTOR,
        agentId: a.agentId,
        eventTypes: ['interaction.created'],
        cursor: a.cursorEventId,
      },
    ])
    expect(
      (await listDispatchableWebhooks(c(), { organizationId: ORG, eligibleAgentIds: [a.agentId, b.agentId] })).map(
        (t) => t.subscriptionId,
      ),
    ).toEqual([a.id, b.id].sort())
    expect(await listDispatchableWebhooks(c(), { organizationId: ORG, eligibleAgentIds: [] })).toEqual([])
    expect(await listDispatchableWebhooks(c(), { organizationId: nextId(), eligibleAgentIds: [a.agentId] })).toEqual([])
  })

  it('deliveries: id order, status filter, after cursor, no lease columns; null for a subscription the caller cannot see; empty for one with none', async () => {
    const a = await make()
    const events = [nextId(), nextId(), nextId()]
    await applyWebhookDispatchPage(c(), {
      organizationId: ORG,
      subscriptionId: a.id,
      createdBy: ACTOR,
      expectedCursor: a.cursorEventId,
      now: NOW,
      events: events.map((e) => ({ id: nextId(), eventId: e, eventType: 'interaction.created' })),
    })
    const all = (await listWebhookDeliveries(c(), { subscriptionId: a.id, limit: 50 }))!
    expect(all.map((d) => d.eventId)).toEqual(events)
    expect(all[0]).toEqual({
      id: all[0]!.id,
      subscriptionId: a.id,
      eventId: events[0],
      eventType: 'interaction.created',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      deliveredAt: null,
      createdAt: NOW,
    })
    expect(Object.keys(all[0]!)).not.toContain('leaseToken')
    expect(
      (await listWebhookDeliveries(c(), { subscriptionId: a.id, after: all[0]!.id, limit: 1 }))!.map((d) => d.id),
    ).toEqual([all[1]!.id])
    expect(await listWebhookDeliveries(c(), { subscriptionId: a.id, status: 'dead', limit: 50 })).toEqual([])
    expect(await listWebhookDeliveries(c(), { subscriptionId: a.id, ownerAgentId: nextId(), limit: 50 })).toBeNull()
    expect(await listWebhookDeliveries(c(), { subscriptionId: nextId(), limit: 50 })).toBeNull()
    const empty = await make()
    expect(await listWebhookDeliveries(c(), { subscriptionId: empty.id, limit: 50 })).toEqual([])
  })
})

describe('group 5: machinery (P3, invariant 3)', () => {
  const page = (a: { id: string }, expectedCursor: string, eventIds: string[], now = NOW) => ({
    organizationId: ORG,
    subscriptionId: a.id,
    createdBy: ACTOR,
    expectedCursor,
    now,
    events: eventIds.map((e) => ({ id: nextId(), eventId: e, eventType: 'task.created' })),
  })
  const seed = async (eventCount: number) => {
    const a = await make()
    const events = Array.from({ length: eventCount }, () => nextId())
    await applyWebhookDispatchPage(c(), page(a, a.cursorEventId, events))
    return { a, events }
  }
  const claim = (over: Partial<Parameters<typeof claimWebhookDeliveries>[1]> = {}) =>
    claimWebhookDeliveries(c(), {
      organizationId: ORG,
      cutoff: NOW,
      now: NOW,
      limit: 100,
      caps: {},
      defaultCap: 10,
      maxAttempts: 8,
      token: nextId(),
      leaseUntil: plus(NOW, 30_000),
      ...over,
    })
  const mine = <T extends { subscriptionId: string }>(subId: string, rowsFound: T[]) =>
    rowsFound.filter((r) => r.subscriptionId === subId)

  it('the cursor advances only from the expected previous cursor: a stale page writes nothing', async () => {
    const a = await make()
    const [e1, e2, e3] = [nextId(), nextId(), nextId()]
    expect(await applyWebhookDispatchPage(c(), page(a, a.cursorEventId, [e1, e2]))).toEqual({ moved: true })
    expect(
      (
        await rows(
          'select cursor_event_id, last_dispatched_at from webhook_dispatch_state where subscription_id = ?',
          a.id,
        )
      )[0],
    ).toEqual({ cursor_event_id: e2, last_dispatched_at: NOW })
    expect(await applyWebhookDispatchPage(c(), page(a, a.cursorEventId, [e3]))).toEqual({ moved: false })
    expect(
      (await rows('select cursor_event_id from webhook_dispatch_state where subscription_id = ?', a.id))[0]!
        .cursor_event_id,
    ).toBe(e2)
    expect(await count('webhook_deliveries', 'subscription_id', a.id)).toBe(2)
  })

  it('a delivery for an existing (subscription, event) is a no-op through ON CONFLICT, and the page still advances', async () => {
    const { a, events } = await seed(2)
    const fresh = nextId()
    expect(await applyWebhookDispatchPage(c(), page(a, events[1]!, [events[1]!, fresh]))).toEqual({ moved: true })
    expect(await count('webhook_deliveries', 'subscription_id', a.id)).toBe(3)
    expect(
      (await rows('select cursor_event_id from webhook_dispatch_state where subscription_id = ?', a.id))[0]!
        .cursor_event_id,
    ).toBe(fresh)
  })

  it('an empty page writes nothing', async () => {
    const a = await make()
    expect(await applyWebhookDispatchPage(c(), page(a, a.cursorEventId, []))).toEqual({ moved: false })
    expect(
      (await rows('select last_dispatched_at from webhook_dispatch_state where subscription_id = ?', a.id))[0]!
        .last_dispatched_at,
    ).toBeNull()
  })

  it('a claim leases due rows (attempts + 1) and a leased row cannot be claimed again before lease_until', async () => {
    const { a, events } = await seed(2)
    const first = await claim()
    const got = mine(a.id, first.rows)
    expect(got.map((r) => r.eventId)).toEqual(events)
    expect(got[0]).toMatchObject({ attempts: 0, url: URL_SECRET, deleted: false, agentId: a.agentId })
    expect(
      (await rows('select attempts, lease_token, lease_until from webhook_deliveries where id = ?', got[0]!.id))[0],
    ).toMatchObject({ attempts: 1, lease_until: plus(NOW, 30_000) })
    expect(mine(a.id, (await claim({ now: plus(NOW, 10_000) })).rows)).toEqual([])
    const again = await claim({ now: plus(NOW, 31_000), cutoff: plus(NOW, 31_000), leaseUntil: plus(NOW, 61_000) })
    expect(mine(a.id, again.rows).map((r) => r.attempts)).toEqual([1, 1])
  })

  it('a row not yet due, a paused subscription and a nothing-due claim are left alone; a deleted subscription is claimed with deleted true; per-subscription caps hold', async () => {
    const { a } = await seed(3)
    expect(mine(a.id, (await claim({ cutoff: plus(NOW, -HOUR) })).rows)).toEqual([])
    const capped = await claim({ caps: { [a.id]: 2 } })
    expect(mine(a.id, capped.rows)).toHaveLength(2)
    const p = await seed(1)
    await updateWebhookSubscription(c(), {
      id: p.a.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, 1),
      expectedUpdatedAt: NOW,
      status: 'paused',
    })
    const d = await seed(1)
    await deleteWebhookSubscription(c(), {
      id: d.a.id,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, 1),
      expectedUpdatedAt: NOW,
    })
    const res = await claim()
    expect(mine(p.a.id, res.rows)).toEqual([])
    expect(mine(d.a.id, res.rows).map((r) => r.deleted)).toEqual([true])
    const none = await claim({ organizationId: nextId() })
    expect(none).toEqual({ rows: [], dead: 0, totalDue: 0 })
  })

  it('a row whose attempts are spent ends dead with sender_failed instead of being leased', async () => {
    const { a } = await seed(1)
    await run('update webhook_deliveries set attempts = 8 where subscription_id = ?', a.id)
    const res = await claim()
    expect(mine(a.id, res.rows)).toEqual([])
    expect(res.dead).toBeGreaterThanOrEqual(1)
    expect(
      (await rows('select status, last_error, lease_token from webhook_deliveries where subscription_id = ?', a.id))[0],
    ).toEqual({ status: 'dead', last_error: 'sender_failed', lease_token: null })
  })

  it('completion, retry, dead and cancel apply only with the matching lease token; a second completion changes nothing', async () => {
    const { a } = await seed(4)
    const token = nextId()
    const got = mine(a.id, (await claim({ token })).rows)
    expect(got).toHaveLength(4)
    const at = plus(NOW, 5_000)
    const outcomes = [
      { id: got[0]!.id, subscriptionId: a.id, kind: 'delivered' as const, statusCode: 204 },
      {
        id: got[1]!.id,
        subscriptionId: a.id,
        kind: 'failed' as const,
        code: 'http_status',
        statusCode: 500,
        nextAttemptAt: plus(NOW, 60_000),
        dead: false,
      },
      {
        id: got[2]!.id,
        subscriptionId: a.id,
        kind: 'failed' as const,
        code: 'timeout',
        statusCode: null,
        nextAttemptAt: null,
        dead: true,
      },
      { id: got[3]!.id, subscriptionId: a.id, kind: 'cancelled' as const, code: 'cancelled_scope' },
    ]
    expect(await recordWebhookDeliveries(c(), { token: nextId(), at, outcomes })).toEqual([false, false, false, false])
    expect(
      (await rows('select status from webhook_deliveries where subscription_id = ?', a.id)).every(
        (r) => r.status === 'pending',
      ),
    ).toBe(true)
    expect(await recordWebhookDeliveries(c(), { token, at, outcomes })).toEqual([true, true, true, true])
    const by = async (id: string) => (await rows('select * from webhook_deliveries where id = ?', id))[0]!
    expect(await by(got[0]!.id)).toMatchObject({
      status: 'delivered',
      delivered_at: at,
      last_status_code: 204,
      last_error: null,
      lease_token: null,
      lease_until: null,
    })
    expect(await by(got[1]!.id)).toMatchObject({
      status: 'pending',
      last_error: 'http_status',
      last_status_code: 500,
      next_attempt_at: plus(NOW, 60_000),
      lease_token: null,
    })
    expect(await by(got[2]!.id)).toMatchObject({ status: 'dead', last_error: 'timeout', next_attempt_at: NOW })
    expect(await by(got[3]!.id)).toMatchObject({
      status: 'cancelled',
      last_error: 'cancelled_scope',
      lease_token: null,
    })
    expect(
      (await rows('select last_success_at from webhook_dispatch_state where subscription_id = ?', a.id))[0]!
        .last_success_at,
    ).toBe(at)
    // The second completion with the same token is stale: the lease was cleared.
    expect(await recordWebhookDeliveries(c(), { token, at: plus(NOW, 9_000), outcomes: [outcomes[0]!] })).toEqual([
      false,
    ])
    expect((await by(got[0]!.id)).delivered_at).toBe(at)
    expect(
      (await rows('select last_success_at from webhook_dispatch_state where subscription_id = ?', a.id))[0]!
        .last_success_at,
    ).toBe(at)
  })

  it('a stale sender whose lease was taken over changes nothing', async () => {
    const { a } = await seed(1)
    const t1 = nextId()
    const first = mine(a.id, (await claim({ token: t1 })).rows)
    const t2 = nextId()
    const later = plus(NOW, 31_000)
    const second = mine(
      a.id,
      (await claim({ token: t2, now: later, cutoff: later, leaseUntil: plus(NOW, 61_000) })).rows,
    )
    expect(second).toHaveLength(1)
    expect(
      await recordWebhookDeliveries(c(), {
        token: t1,
        at: later,
        outcomes: [{ id: first[0]!.id, subscriptionId: a.id, kind: 'delivered', statusCode: 200 }],
      }),
    ).toEqual([false])
    expect((await rows('select status, lease_token from webhook_deliveries where id = ?', first[0]!.id))[0]).toEqual({
      status: 'pending',
      lease_token: t2,
    })
  })

  it('none of the machinery writes a control_audit row', async () => {
    const before = Number((await rows('select count(*) as n from control_audit'))[0]!.n)
    const { a } = await seed(2)
    const token = nextId()
    const got = mine(a.id, (await claim({ token })).rows)
    await recordWebhookDeliveries(c(), {
      token,
      at: NOW,
      outcomes: got.map((r) => ({ id: r.id, subscriptionId: a.id, kind: 'delivered' as const, statusCode: 200 })),
    })
    const after = Number((await rows('select count(*) as n from control_audit'))[0]!.n)
    expect(after - before).toBe(1) // only the create's own row
    expect((await audit(a.id)).map((r) => r.action)).toEqual(['webhook.created'])
  })
})

describe('group 6: dormant and bounded (D5, P5)', () => {
  const PACKAGES = fileURLToPath(new URL('../../', import.meta.url))
  const NAMES =
    /\b(createWebhookSubscription|updateWebhookSubscription|deleteWebhookSubscription|rotateWebhookSecret|getWebhookSubscription|listWebhookSubscriptions|listWebhookDeliveries|readWebhookSecrets|listDispatchableWebhooks|applyWebhookDispatchPage|claimWebhookDeliveries|recordWebhookDeliveries)\b/
  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.wrangler') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) yield* sources(path)
      else if (/\.ts$/.test(name) && !/\.(test|suite)\.ts$/.test(name)) yield path
    }
  }
  it('no production module outside the control store and its package index names the new store methods', () => {
    const hits: string[] = []
    for (const pkg of readdirSync(PACKAGES)) {
      for (const sub of ['src', 'scripts']) {
        let files: string[] = []
        try {
          files = [...sources(join(PACKAGES, pkg, sub))]
        } catch {
          continue
        }
        for (const f of files) {
          const rel = f.slice(PACKAGES.length)
          if (rel === 'storage-d1/src/control-store.ts' || rel === 'storage-d1/src/index.ts') continue
          if (NAMES.test(readFileSync(f, 'utf8'))) hits.push(rel)
        }
      }
    }
    expect(hits).toEqual([])
  })
})
