import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getWithAssociations } from '../associations/embed.js'
import { endpointTypesOf } from '../associations/definition.js'
import { messages } from '../resources/messages.js'
import { ScopeSet } from '../scopes.js'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { openSenderKit, type SenderKit } from '../test/sender-kit.js'

// API514 D5, D6, D11 (projection half), group 2 and the at-everything half of group 4: every output path of a message goes through the one
// projection. No caller below `messages:read` can reach messages yet, so the seam is a reveal scope that differs from the read scope: the
// real `messages` definition is declared with `messages:write` as the scope that reveals the content (restored after each test), and a
// caller holding `messages:read` and not `messages:write` is below `everything`. The paths are the real operations, the real registry's
// feed and the real webhook sender; nothing is re-implemented here.
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const REVEAL = { resource: 'messages', action: 'write' } as const
const BASE = ['events:read', 'messages:read', 'associations:read']
const BELOW = BASE
const AT = [...BASE, 'messages:write']

let s: SenderKit
beforeAll(async () => {
  s = await openSenderKit()
})
afterAll(() => s.close())
beforeEach(() => s.reset())

const original = messages.content
const reveal = (on: boolean) => {
  ;(messages as { content?: unknown }).content = on ? { ...original!, requires: REVEAL } : original
}
afterEach(() => reveal(false))

const user = (scopes: string[], path: string) => s.k.call({ as: 'user', scopes }, 'GET', path)
async function capture() {
  await runCapture(s.k.e, {
    source: { kind: 'connection', id: C1 },
    channel: 'email',
    messages: [captureMessage(s.k.e.organizationId, { attachments: 1 })],
  })
  const row = (await s.k.crm('select id from messages order by id desc limit 1'))[0]!
  return row.id as string
}
const events = (type: string) => s.k.crm('select id, before, after from events where type = ? order by seq', type)
const stored = () => s.k.crm("select * from events where type like 'message.%' order by seq")

/** A stored message.updated event, written the way the feed reads it: the whole record in before and after. */
async function updatedEvent(id: string): Promise<string> {
  const record = (await user(['messages:read'], `/api/v1/messages/${id}`)).body
  return s.k.rawEvent('message.updated', {
    resourceType: 'message',
    resourceId: id,
    before: record,
    after: { ...record, version: 2 },
  })
}

type Path = (scopes: string[], id: string) => Promise<Array<Record<string, unknown>>>
const eventSides = (e: any) => [e.before, e.after].filter((x): x is Record<string, unknown> => x !== null)
const PATHS: Array<[string, Path]> = [
  ['messages.list', async (scopes) => (await user(scopes, '/api/v1/messages')).body.data],
  ['messages.get', async (scopes, id) => [(await user(scopes, `/api/v1/messages/${id}`)).body]],
  [
    'an association read that renders a message (getWithAssociations)',
    async (scopes, id) => [
      (
        await s.k.e.run(
          getWithAssociations(
            messages,
            s.k.e.env({ scopes: ScopeSet.parse(scopes) }),
            endpointTypesOf(s.k.registry.resources()),
            id,
          ),
        )
      ).value as Record<string, unknown>,
    ],
  ],
  [
    'events.list (message.created and message.updated, before and after)',
    async (scopes, id) => {
      await updatedEvent(id)
      const r = await user(scopes, '/api/v1/events?limit=200')
      return r.body.data.filter((e: any) => e.type.startsWith('message.')).flatMap(eventSides)
    },
  ],
  [
    'events.get (a created and an updated event)',
    async (scopes, id) => {
      const ids = [(await events('message.created'))[0]!.id, await updatedEvent(id)]
      return (await Promise.all(ids.map((e) => user(scopes, `/api/v1/events/${e}`)))).flatMap((r) => eventSides(r.body))
    },
  ],
  [
    'a webhook delivery payload',
    async (scopes) => {
      const { sub } = await s.subscribe({ scopes, event_types: ['message.created'] })
      await capture()
      await s.k.dispatch()
      await s.send()
      const call = s.calls.at(-1)
      expect(call, `a delivery for ${sub.id}`).toBeDefined()
      return eventSides(JSON.parse(call!.body))
    },
  ],
]

describe('every output path projects through the one function (matrix: path x caller)', () => {
  it.each(PATHS)('%s', async (_name, path) => {
    reveal(true)
    const id = await capture()
    const below = await path(BELOW, id)
    s.calls.length = 0
    await s.reset()
    reveal(true)
    const idAt = await capture()
    const at = await path(AT, idAt)
    expect(below.length).toBeGreaterThan(0)
    expect(at.length).toBe(below.length)
    for (const r of below) {
      expect('preview' in r, 'preview absent below everything').toBe(false)
      expect('attachments' in r, 'attachments absent below everything').toBe(false)
      expect(r.thread_id, 'the other fields are there').toBeTypeOf('string')
    }
    for (const r of at) {
      expect(r.preview, 'preview at everything').toBeTypeOf('string')
      expect(r.attachments, 'attachments at everything').toHaveLength(1)
    }
  })
})

describe('events stay stored whole', () => {
  it('the stored event rows are byte-identical before and after a below-everything read of every path', async () => {
    reveal(true)
    const id = await capture()
    await updatedEvent(id)
    const before = JSON.stringify(await stored())
    await user(BELOW, '/api/v1/events?limit=200')
    for (const e of await events('message.created')) await user(BELOW, `/api/v1/events/${e.id}`)
    expect(JSON.stringify(await stored())).toBe(before)
    const row = (await events('message.created'))[0]!
    expect(JSON.parse(row.after).preview).toBeTypeOf('string')
    expect(JSON.parse(row.after).attachments).toHaveLength(1)
  })
})

describe('nothing changes for a messages:read reader (group 4, at-everything half)', () => {
  it('with the definition as shipped, a messages:read caller gets the whole record on every path', async () => {
    const id = await capture()
    for (const [name, path] of PATHS) {
      for (const r of await path(['events:read', 'messages:read', 'associations:read'], id)) {
        expect(r.preview, name).toBeTypeOf('string')
        expect(r.attachments, name).toHaveLength(1)
      }
    }
  })

  it('an event read by that caller is exactly the stored event', async () => {
    const id = await capture()
    await updatedEvent(id)
    const rows = await stored()
    const got = (await user(BASE, '/api/v1/events?limit=200')).body.data.filter((e: any) =>
      e.type.startsWith('message.'),
    )
    expect(got.map((e: any) => [e.id, e.before, e.after])).toEqual(
      rows.map((r: any) => [
        r.id,
        r.before === null ? null : JSON.parse(r.before),
        r.after === null ? null : JSON.parse(r.after),
      ]),
    )
  })
})
