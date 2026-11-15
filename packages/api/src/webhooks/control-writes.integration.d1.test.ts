import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { readStableFeed } from '../events/feed.js'
import { openWebhookKit, type WebhookKit } from '../test/webhook-kit.js'
import { NIL_CURSOR } from './crm-reads.js'

// CORE337 group 1 (P1, D9 (c), D12): every subscription write is ONE control batch with exactly one `control_audit` row and nothing on the CRM side: no `events` row, no CRM `webhook_*` row. Reads write nothing.
// The creation horizon (API7 D5) is now the newest CRM event at creation (the operation no longer emits its own), the nil position on an empty feed.
let k: WebhookKit
beforeAll(async () => {
  k = await openWebhookKit()
})
afterAll(() => k.close())
beforeEach(() => k.reset())

const BASE = '/meta/v1/webhooks'
const TASKS = ['tasks:read']
const audit = () => k.all('select action, actor_id, target_type, target_id, detail from control_audit order by at, id')
const detailOf = (r: any) => JSON.parse(r.detail)
const crmWebhookRows = async () => ({
  subscriptions: (await k.crm('select id from webhook_subscriptions')).length,
  secrets: (await k.crm('select id from webhook_secrets')).length,
  state: (await k.crm('select subscription_id from webhook_dispatch_state')).length,
  deliveries: (await k.crm('select id from webhook_deliveries')).length,
  webhookEvents: (await k.crm("select id from events where type like 'webhook.%'")).length,
})
const counts = async () => ({
  subscriptions: (await k.all('select id from webhook_subscriptions')).length,
  secrets: (await k.all('select id from webhook_secrets')).length,
  state: (await k.all('select subscription_id from webhook_dispatch_state')).length,
  audit: (await audit()).length,
  events: (await k.crm('select id from events')).length,
})

describe('writes on control with one audit row each', () => {
  it('create: the subscription, its sealed secret and its dispatch state are in control, with ONE webhook.created audit row (url origin, never the path), and the CRM is untouched', async () => {
    const a = await k.seedAgent(TASKS)
    const eventsBefore = (await k.crm('select id from events')).length
    const made = await k.create(a, { url: 'https://example.com/secret/path?token=abc' })
    expect(await k.all('select id, agent_id, status from webhook_subscriptions')).toEqual([
      { id: made.id, agent_id: a, status: 'active' },
    ])
    expect(await k.all('select subscription_id from webhook_secrets')).toEqual([{ subscription_id: made.id }])
    expect(await k.all('select subscription_id from webhook_dispatch_state')).toEqual([{ subscription_id: made.id }])
    const rows = await audit()
    expect(rows).toHaveLength(1)
    expect([rows[0]!.action, rows[0]!.actor_id, rows[0]!.target_type, rows[0]!.target_id]).toEqual([
      'webhook.created',
      k.e.userId,
      'webhook',
      made.id,
    ])
    expect(detailOf(rows[0]!)).toEqual({
      agent_id: a,
      event_types: ['task.created'],
      status: 'active',
      url_origin: 'https://example.com',
    })
    expect(rows[0]!.detail).not.toContain('secret/path')
    expect(await crmWebhookRows()).toEqual({ subscriptions: 0, secrets: 0, state: 0, deliveries: 0, webhookEvents: 0 })
    expect((await k.crm('select id from events')).length).toBe(eventsBefore)
  })

  it('update: the row changes in control and ONE webhook.updated audit row names what changed; no event', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const eventsBefore = (await k.crm('select id from events')).length
    const r = await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused', url: 'https://example.org/h' })
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ id: made.id, status: 'paused', url: 'https://example.org/h' })
    expect(await k.all('select status, url from webhook_subscriptions')).toEqual([
      { status: 'paused', url: 'https://example.org/h' },
    ])
    const rows = (await audit()).filter((x) => x.action === 'webhook.updated')
    expect(rows).toHaveLength(1)
    expect(detailOf(rows[0]!)).toMatchObject({
      changed: ['url', 'status'],
      status: 'paused',
      url_origin: 'https://example.org',
    })
    expect(await crmWebhookRows()).toMatchObject({ subscriptions: 0, webhookEvents: 0 })
    expect((await k.crm('select id from events')).length).toBe(eventsBefore)
  })

  it('delete: the row is soft-deleted in control and ONE webhook.deleted audit row holds the agent; no event', async () => {
    const a = await k.seedAgent(TASKS)
    const made = await k.create(a)
    const eventsBefore = (await k.crm('select id from events')).length
    expect((await k.owner('DELETE', `${BASE}/${made.id}`)).status).toBe(204)
    expect((await k.all('select deleted_at from webhook_subscriptions'))[0]!.deleted_at).not.toBeNull()
    const rows = (await audit()).filter((x) => x.action === 'webhook.deleted')
    expect(rows).toHaveLength(1)
    expect(detailOf(rows[0]!)).toEqual({ agent_id: a })
    expect(await crmWebhookRows()).toMatchObject({ subscriptions: 0, webhookEvents: 0 })
    expect((await k.crm('select id from events')).length).toBe(eventsBefore)
  })

  it('rotate_secret: a NEW secret row in control and ONE webhook.secret_rotated audit row naming it, never the secret; no event', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const eventsBefore = (await k.crm('select id from events')).length
    const r = await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)
    expect(r.status, r.text).toBe(200)
    const secrets = await k.all('select id, sealed from webhook_secrets order by created_at, id')
    expect(secrets).toHaveLength(2)
    const rows = (await audit()).filter((x) => x.action === 'webhook.secret_rotated')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.target_id).toBe(made.id)
    expect(secrets.map((s) => s.id)).toContain(detailOf(rows[0]!).secret_id)
    expect(rows[0]!.detail).not.toContain(r.body.secret)
    for (const s of secrets) expect(rows[0]!.detail).not.toContain(s.sealed)
    expect(await crmWebhookRows()).toMatchObject({ secrets: 0, webhookEvents: 0 })
    expect((await k.crm('select id from events')).length).toBe(eventsBefore)
  })

  it('an agent caller is the actor of its own writes', async () => {
    await k.grant(k.e.agentId, TASKS)
    const made = (await k.agent('POST', BASE, { url: 'https://example.com/hook', event_types: ['task.created'] })).body
    await k.agent('POST', `${BASE}/${made.id}/rotate-secret`)
    expect((await audit()).map((e) => [e.action, e.actor_id])).toEqual([
      ['webhook.created', k.e.agentId],
      ['webhook.secret_rotated', k.e.agentId],
    ])
  })

  it('reads write nothing, whether they find the subscription or not', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = await counts()
    await k.owner('GET', BASE)
    await k.owner('GET', `${BASE}/${made.id}`)
    await k.owner('GET', `${BASE}/${made.id}/deliveries`)
    await k.owner('GET', `${BASE}/${uuidv7()}`)
    expect(await counts()).toEqual(before)
  })

  it('refused writes write nothing, audit included', async () => {
    const a = await k.seedAgent(TASKS)
    const before = await counts()
    await k.owner('POST', BASE, { url: 'http://example.com', agent_id: a })
    await k.owner('POST', BASE, { url: 'https://example.com/hook', agent_id: a, event_types: ['bogus.x'] })
    await k.owner('PATCH', `${BASE}/${uuidv7()}`, { status: 'paused' })
    await k.owner('DELETE', `${BASE}/${uuidv7()}`)
    await k.owner('POST', `${BASE}/${uuidv7()}/rotate-secret`)
    expect(await counts()).toEqual(before)
  })
})

describe('atomicity in control: a failing statement leaves nothing of the batch', () => {
  const failing = async (table: string, when: string, run: () => Promise<unknown>) => {
    await k.control
      .prepare(`CREATE TRIGGER boom BEFORE INSERT ON ${table} ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
      .run()
    try {
      await run()
    } finally {
      await k.control.prepare('DROP TRIGGER boom').run()
    }
  }

  it('create: a failing dispatch-state row leaves no subscription, secret, state or audit row', async () => {
    const a = await k.seedAgent(TASKS)
    const before = await counts()
    await failing('webhook_dispatch_state', '', async () => {
      const r = await k.owner('POST', BASE, {
        url: 'https://example.com/hook',
        agent_id: a,
        event_types: ['task.created'],
      })
      expect(r.status).toBeGreaterThanOrEqual(500)
    })
    expect(await counts()).toEqual(before)
  })

  it('create: a failing audit row leaves no subscription, secret or state row', async () => {
    const a = await k.seedAgent(TASKS)
    const before = await counts()
    await failing('control_audit', '', async () => {
      expect(
        (await k.owner('POST', BASE, { url: 'https://example.com/hook', agent_id: a, event_types: ['task.created'] }))
          .status,
      ).toBeGreaterThanOrEqual(500)
    })
    expect(await counts()).toEqual(before)
  })

  it('rotate_secret: a failing audit row leaves no new secret row', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const before = await counts()
    await failing('control_audit', "WHEN NEW.action = 'webhook.secret_rotated'", async () => {
      expect((await k.owner('POST', `${BASE}/${made.id}/rotate-secret`)).status).toBeGreaterThanOrEqual(500)
    })
    expect(await counts()).toEqual(before)
  })
})

describe('drift between the read and the control write (D4 of CORE327, AGT8 D28)', () => {
  /** Lets `times` calls of the port method move the row first (a concurrent writer), then runs the real one. */
  const racing = (method: 'update' | 'delete', id: string, times: number) => {
    const port = k.runtime.port!
    const real = port[method] as (a: any) => Promise<unknown>
    let left = times
    ;(port as any)[method] = async (a: any) => {
      if (left-- > 0)
        await k.control
          .prepare('UPDATE webhook_subscriptions SET updated_at = ? WHERE id = ?')
          .bind(new Date(Date.parse(a.now) + 1 + left).toISOString(), id)
          .run()
      return real(a)
    }
    return () => void ((port as any)[method] = real)
  }

  it('one concurrent move is planned afresh and applies: 200 with the change, ONE audit row', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    const restore = racing('update', made.id, 1)
    try {
      const r = await k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })
      expect(r.status, r.text).toBe(200)
      expect(r.body.status).toBe('paused')
    } finally {
      restore()
    }
    expect((await audit()).filter((x) => x.action === 'webhook.updated')).toHaveLength(1)
  })

  it('a second move is 409 conflict and nothing is written, audit included (update and delete)', async () => {
    const made = await k.create(await k.seedAgent(TASKS))
    for (const [method, call] of [
      ['update', () => k.owner('PATCH', `${BASE}/${made.id}`, { status: 'paused' })],
      ['delete', () => k.owner('DELETE', `${BASE}/${made.id}`)],
    ] as const) {
      const before = await counts()
      const restore = racing(method, made.id, 2)
      try {
        const r = await call()
        expect([method, r.status, r.body?.error?.code]).toEqual([method, 409, 'conflict'])
      } finally {
        restore()
      }
      expect(await counts(), method).toEqual(before)
      expect((await k.all('select status, deleted_at from webhook_subscriptions'))[0], method).toEqual({
        status: 'active',
        deleted_at: null,
      })
    }
  })
})

describe('the creation horizon (D5)', () => {
  const seqOf = async (id: string) =>
    ((await k.crm('select seq from events where id = ?', id))[0] as { seq: number }).seq
  const feedAfter = async (cursor: string) => {
    const feed = (
      await k.e.run(readStableFeed({ readable: ['task'], after: cursor === NIL_CURSOR ? null : cursor, limit: 100 }))
    ).value
    if (feed.status !== 'ok') throw new Error('unknown cursor')
    return feed.events.map((e) => e.id)
  }

  it('an event committed before creation is at or before the cursor; one committed after is strictly after it', async () => {
    const early = await k.rawEvent('task.created')
    const made = await k.create(await k.seedAgent(TASKS))
    const late = await k.rawEvent('task.updated')
    const cursor = await k.cursorOf(made.id)
    expect(await seqOf(early)).toBeLessThanOrEqual(await seqOf(cursor))
    expect(await seqOf(late)).toBeGreaterThan(await seqOf(cursor))
    expect(await feedAfter(cursor)).toEqual([late])
  })

  it('the cursor is the newest CRM event at creation; with an empty feed it is the nil position and the first event after is read from the start', async () => {
    await k.crm('delete from events')
    const made = await k.create(await k.seedAgent(TASKS))
    expect(await k.cursorOf(made.id)).toBe(NIL_CURSOR)
    const first = await k.rawEvent('task.created')
    expect(await feedAfter(NIL_CURSOR)).toEqual([first])
    expect(
      await k.all(
        'select last_dispatched_at, last_success_at from webhook_dispatch_state where subscription_id = ?',
        made.id,
      ),
    ).toEqual([{ last_dispatched_at: null, last_success_at: null }])
  })

  it('a second subscription gets its own horizon: the newest event at its creation', async () => {
    const a = await k.seedAgent(TASKS)
    const first = await k.create(a)
    const mid = await k.rawEvent('task.created')
    const second = await k.create(a)
    expect(await k.cursorOf(second.id)).toBe(mid)
    expect(await feedAfter(await k.cursorOf(first.id))).toEqual([mid])
    expect(await feedAfter(await k.cursorOf(second.id))).toEqual([])
  })
})
