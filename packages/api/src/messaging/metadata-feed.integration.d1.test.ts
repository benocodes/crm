import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { openSenderKit, type SenderKit } from '../test/sender-kit.js'

// [[API516]] group 3 (D11, visibility half): events:read plus messages:read_metadata sees message.* and thread.* events on events.list, events.get and webhook deliveries, projected by the
// content projection; an agent stored with messages:read (no read_metadata stored) still gets them whole; events:read alone sees none.
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const META = ['events:read', 'messages:read_metadata']
const READ = ['events:read', 'messages:read']
const NEITHER = ['events:read']
const TYPES = ['message.created', 'thread.created']

let s: SenderKit
beforeAll(async () => {
  s = await openSenderKit()
})
afterAll(() => s.close())
beforeEach(() => s.reset())

async function capture() {
  await runCapture(s.k.e, {
    source: { kind: 'connection', id: C1 },
    channel: 'email',
    messages: [captureMessage(s.k.e.organizationId, { attachments: 1 })],
  })
}
const feed = async (scopes: string[]) =>
  (await s.k.call({ as: 'agent', scopes }, 'GET', '/api/v1/events?limit=200')).body.data.filter(
    (e: any) => e.type.startsWith('message.') || e.type.startsWith('thread.'),
  ) as any[]
const sides = (e: any) => [e.before, e.after].filter((x) => x !== null && x !== undefined)

describe('the feed (events.list, events.get)', () => {
  it('a metadata holder sees message.* and thread.* events, with before/after lacking the content keys', async () => {
    await capture()
    const events = await feed(META)
    expect(events.map((e) => e.type).sort()).toEqual(expect.arrayContaining(['message.created', 'thread.created']))
    const message = events.find((e) => e.type === 'message.created')
    expect(message.after.thread_id).toBeTypeOf('string')
    for (const side of sides(message)) {
      expect('preview' in side).toBe(false)
      expect('attachments' in side).toBe(false)
    }
    const got = await s.k.call({ as: 'agent', scopes: META }, 'GET', `/api/v1/events/${message.id}`)
    expect(got.status).toBe(200)
    expect('preview' in got.body.after).toBe(false)
    expect('attachments' in got.body.after).toBe(false)
  })
  it('a messages:read agent (nothing about read_metadata stored) still sees the events whole', async () => {
    await capture()
    const message = (await feed(READ)).find((e) => e.type === 'message.created')
    expect(message.after.preview).toBeTypeOf('string')
    expect(message.after.attachments).toHaveLength(1)
  })
  it('events:read alone sees no message or thread event, and events.get answers not found', async () => {
    await capture()
    const stored = (await s.k.crm("select id from events where type = 'message.created'"))[0]!.id
    expect(await feed(NEITHER)).toEqual([])
    expect((await s.k.call({ as: 'agent', scopes: NEITHER }, 'GET', `/api/v1/events/${stored}`)).status).toBe(404)
  })
  it('the stored events stay whole', async () => {
    await capture()
    await feed(META)
    const row = (await s.k.crm("select after from events where type = 'message.created'"))[0]!
    expect(JSON.parse(row.after).preview).toBeTypeOf('string')
  })
})

describe('webhook deliveries', () => {
  const deliver = async (scopes: string[]) => {
    const { sub } = await s.subscribe({ scopes, event_types: TYPES })
    await capture()
    await s.k.dispatch()
    await s.send()
    return { sub, calls: s.calls.map((c) => JSON.parse(c.body)) }
  }
  it('a metadata agent’s delivery carries the projected payload (message and thread events)', async () => {
    const { calls } = await deliver(META)
    expect(calls.map((c) => c.type).sort()).toEqual(['message.created', 'thread.created'])
    for (const side of calls.flatMap(sides)) {
      expect('preview' in side).toBe(false)
      expect('attachments' in side).toBe(false)
    }
  })
  it('an agent stored with messages:read still receives them whole', async () => {
    const { calls } = await deliver(READ)
    const message = calls.find((c) => c.type === 'message.created')
    expect(message.after.preview).toBeTypeOf('string')
    expect(message.after.attachments).toHaveLength(1)
  })
  it('an agent that holds events:read alone gets no delivery', async () => {
    const { sub, agent } = await (async () => {
      const made = await s.subscribe({ scopes: READ, event_types: TYPES })
      await s.k.grant(made.agent, NEITHER)
      return { sub: made.sub, agent: made.agent }
    })()
    await capture()
    await s.k.dispatch()
    expect(await s.k.deliveries(sub.id), agent).toEqual([])
  })
})
