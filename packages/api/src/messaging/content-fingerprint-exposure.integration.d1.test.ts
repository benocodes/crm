import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { openActionKit, type ActionKit } from '../test/action-kit.js'
import { memoryObjectStore } from '../objects/store.js'
import { FakeChannel } from '../test/channels.js'
import { ensureConnection } from '../test/capture-kit.js'
import { mintTestUserToken } from '../test/user-auth.js'
import { nodeStreams } from '../test/streams.js'
import { captureMessages } from './pipeline.js'

// [[CORE574]] P3: `messages.content_sha256` is never exposed. A hash of subject, sender and body is a content oracle for a
// `messages:read_metadata` holder, so no read, event or schema document carries the column or the digest, and it is no filter or sort.
let k: ActionKit
let message: string
let thread: string
let digest: string
const CONN = '0190b2c4-0000-7000-8000-0000000000c1'

beforeAll(async () => {
  const objects = memoryObjectStore()
  k = await openActionKit({ objects })
  await k.reset()
  await ensureConnection(k.binding, { organizationId: k.organizationId, userId: k.owner.id }, CONN)
  await captureMessages(
    {
      binding: k.binding,
      organizationId: k.organizationId,
      actorId: k.owner.id,
      objects,
      streams: nodeStreams(),
      clock: () => new Date('2026-10-22T10:00:00.000Z'),
      newId: () => uuidv7(new Date('2026-10-22T10:00:00.000Z')),
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    },
    new FakeChannel([{ providerMessageId: 'p1', subject: 'Hello', markdown: 'Body text' }]),
    { id: CONN },
    ['p1'],
  )
  const row = (await k.rows('messages'))[0]!
  message = row.id as string
  thread = row.thread_id as string
  digest = row.content_sha256 as string
})
afterAll(() => k.close())

const mcp = async (name: string, args: unknown) => {
  const token = mintTestUserToken({
    userId: k.owner.id,
    organizationId: k.organizationId,
    scopes: k.owner.scopes,
    kind: 'user',
  })
  const res = await k.app.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return JSON.stringify(await res.json())
}
const clean = (label: string, text: string) => {
  expect(text, `${label} carries no column name`).not.toContain('content_sha256')
  expect(text, `${label} carries no digest`).not.toContain(digest)
}

describe('content_sha256 is stored and never exposed', () => {
  it('the capture stored a digest', () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('messages.get, messages.list, messages.content and the thread reads (REST)', async () => {
    for (const path of [
      `/api/v1/messages/${message}`,
      '/api/v1/messages',
      `/api/v1/messages/${message}/content`,
      `/api/v1/threads/${thread}`,
      '/api/v1/threads',
      '/api/v1/interactions',
    ]) {
      const r = await k.call(k.owner, 'GET', path)
      expect(r.status, path).toBe(200)
      clean(path, JSON.stringify(r.body))
    }
  })

  it('the same reads over MCP', async () => {
    for (const [name, args] of [
      ['messages_get', { id: message }],
      ['messages_list', {}],
      ['messages_content', { id: message }],
      ['threads_get', { id: thread }],
      ['threads_list', {}],
    ] as const) {
      const text = await mcp(name, args)
      expect(text, name).toContain(name === 'messages_content' ? 'Body text' : message.slice(0, 8))
      clean(name, text)
    }
  })

  it('every event the capture page emitted, and the events read', async () => {
    const events = await k.events()
    expect(events.map((x) => x.type)).toEqual(
      expect.arrayContaining(['message.created', 'interaction.created', 'thread.created']),
    )
    clean('events table', JSON.stringify(events))
    const read = await k.call(k.owner, 'GET', '/api/v1/events')
    expect(read.status).toBe(200)
    clean('events.list', JSON.stringify(read.body))
  })

  it('schema.get lists no such column', async () => {
    const r = await k.call(k.owner, 'GET', '/meta/v1/schema')
    expect(r.status).toBe(200)
    clean('schema.get', JSON.stringify(r.body))
    const messages = r.body.tables.find((t: any) => t.name === 'messages')
    expect(messages.columns.map((c: any) => c.name)).toContain('content_key')
  })

  it('a content_sha256 filter or sort is refused like any unknown field', async () => {
    const unknown = await k.call(k.owner, 'GET', '/api/v1/messages?no_such_field=x')
    const sortUnknown = await k.call(k.owner, 'GET', '/api/v1/messages?sort=no_such_field')
    expect(unknown.status).toBeGreaterThanOrEqual(400)
    expect(sortUnknown.status).toBeGreaterThanOrEqual(400)
    const filter = await k.call(k.owner, 'GET', `/api/v1/messages?content_sha256=${digest}`)
    expect(filter.status).toBe(unknown.status)
    expect(filter.body?.error?.code).toBe(unknown.body?.error?.code)
    const sort = await k.call(k.owner, 'GET', '/api/v1/messages?sort=content_sha256')
    expect(sort.status).toBe(sortUnknown.status)
    expect(sort.body?.error?.code).toBe(sortUnknown.body?.error?.code)
  })
})
