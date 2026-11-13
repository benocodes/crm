import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { memoryObjectStore } from '../../objects/store.js'
import { captureMessages, type PipelineContext } from '../../messaging/pipeline.js'
import { ensureConnection } from '../../test/capture-kit.js'
import { bytesOf } from '../../test/channels.js'
import { openEngines, type Engine } from '../../test/engines.js'
import { FakeGmail, type BuiltGmailMessage } from '../../test/gmail.js'
import { gmailFixture, MAILBOX, type FixtureName } from '../../test/gmail-fixtures.js'
import { recordingObjectStore } from '../../test/objects.js'
import { nodeStreams } from '../../test/streams.js'
import { GmailApiError } from './client.js'
import { GmailChannel } from './channel.js'
import type { MessageSpec } from '../../test/gmail.js'

// [[CHN5]] cycle 1: the Gmail channel through [[CORE69]]'s pipeline on local D1, over FakeGmail's wire form and a memory object store.
const NOW = '2026-10-22T10:00:00.000Z'
const C1 = { id: '0190b2c4-0000-7000-8000-0000000000c1', mailbox: MAILBOX }
const C2 = { id: '0190b2c4-0000-7000-8000-0000000000c2', mailbox: 'second@vault.test' }
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))
const readAll = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> => new Uint8Array(await new Response(s).arrayBuffer())

describe('Gmail capture through the pipeline (D1)', () => {
  let engines: Engine[]
  let e: Engine
  beforeAll(async () => {
    engines = await openEngines(['d1'])
    e = engines[0]!
  })
  afterAll(async () => {
    for (const x of engines) await x.close()
  })
  beforeEach(async () => {
    await e.reset()
  })

  function setup(messages: BuiltGmailMessage[], over: Partial<PipelineContext> = {}) {
    const gmail = new FakeGmail(messages, { chunk: (i) => 100 + ((i * 131) % 4000) })
    const objects = recordingObjectStore(memoryObjectStore())
    const ctx: PipelineContext = {
      binding: e.binding,
      organizationId: e.organizationId,
      actorId: e.userId,
      objects,
      streams: nodeStreams(),
      clock: () => new Date(NOW),
      newId: () => uuidv7(new Date(NOW)),
      randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
      ...over,
    }
    const channel = new GmailChannel(gmail)
    const run = async (ids: string[], conn = C1) => {
      await ensureConnection(e.binding, e, conn.id)
      return captureMessages(ctx, channel, conn, ids)
    }
    return { gmail, objects, run }
  }
  const fx = (name: FixtureName, adjust?: (s: MessageSpec) => MessageSpec) => gmailFixture(name, adjust)
  const ops = (g: FakeGmail, op: string): number => g.calls.filter((c) => c.op === op).length

  it('captures thread, message, interaction, participants, both sources, body.md and a byte-identical original, with the owner as actor', async () => {
    const att = fx('attachment')
    const t = setup([att, fx('htmlOnly')])
    const result = await t.run(['with-attachment', 'html-only'])
    expect(result).toEqual({ captured: 2, existing: 0, skipped: {}, attachments: { stored: 1, failed: 0, skipped: 0 }, orphaned_objects: 0 })

    expect(await e.rows('threads')).toHaveLength(2)
    const messages = await e.rows('messages')
    expect(messages).toHaveLength(2)
    const m = messages.find((r) => r.external_id === 'with-attachment@acme.test')!
    expect(m).toMatchObject({ channel: 'email', kind: 'message', preview: 'Report attached', in_reply_to: null })
    const interactions = await e.rows('interactions')
    expect(interactions).toHaveLength(2)
    expect(interactions.find((r) => r.message_id === m.id)).toMatchObject({ direction: 'inbound', channel: 'email' })
    expect((await e.rows('interaction_participants')).length).toBeGreaterThanOrEqual(4)
    expect((await e.rows('message_sources')).map((r) => r.provider_message_id).sort()).toEqual(['html-only', 'with-attachment'])
    expect((await e.rows('thread_sources')).map((r) => r.provider_thread_id).sort()).toEqual(['t-html-only', 't-with-attachment'])

    const body = await t.objects.get(`${m.content_key}/v1/body.md`)
    expect(new TextDecoder().decode(await readAll(body!.body))).toBe('Report attached\n')
    const original = await t.objects.get(`${m.content_key}/v1/original.eml`)
    expect(same(await readAll(original!.body), att.rfc822)).toBe(true)
    expect(original!.contentType).toBe('message/rfc822')

    const events = await e.rows('events')
    expect(events.filter((r) => r.type === 'message.created')).toHaveLength(2)
    expect(events.filter((r) => r.type === 'thread.created')).toHaveLength(2)
    expect(events.filter((r) => r.type === 'interaction.created')).toHaveLength(2)
    expect(events.every((r) => r.actor_id === e.userId)).toBe(true)
  })

  it('a reply lands in its parent thread through the References hints', async () => {
    const parent = fx('plain', (s) => ({ ...s, headers: s.headers.map(([k, v]) => [k, k === 'Message-ID' ? '<c@acme.test>' : v]), id: 'parent', threadId: 't-parent' }))
    const t = setup([fx('reply'), parent])
    await t.run(['reply', 'parent'])
    expect(new Set((await e.rows('messages')).map((r) => r.thread_id)).size).toBe(1)
    expect(await e.rows('threads')).toHaveLength(1)
  })

  it('the same mail through two connection ids is one message, one interaction, two sources, one message.created', async () => {
    const t = setup([fx('attachment')])
    await t.run(['with-attachment'], C1)
    await t.run(['with-attachment'], C2)
    expect(await e.rows('messages')).toHaveLength(1)
    expect(await e.rows('interactions')).toHaveLength(1)
    expect(await e.rows('message_sources')).toHaveLength(2)
    expect((await e.rows('events')).filter((r) => r.type === 'message.created')).toHaveLength(1)
  })

  it('lazy raw: a message found to exist requests neither raw nor an attachment', async () => {
    const t = setup([fx('attachment'), fx('plain')])
    await t.run(['with-attachment', 'plain'])
    expect([ops(t.gmail, 'raw'), ops(t.gmail, 'attachment'), ops(t.gmail, 'full')]).toEqual([2, 1, 2])
    const writes = t.objects.writes.length
    const second = await t.run(['with-attachment', 'plain'], C2)
    expect(second).toMatchObject({ captured: 0, existing: 2 })
    expect([ops(t.gmail, 'raw'), ops(t.gmail, 'attachment'), ops(t.gmail, 'full')]).toEqual([2, 1, 4])
    expect(t.objects.writes).toHaveLength(writes)
  })

  it('a self-addressed message (INBOX + SENT) is one outbound interaction with one source', async () => {
    const t = setup([fx('selfAddressed')])
    const result = await t.run(['self'])
    expect(result.captured).toBe(1)
    const interactions = await e.rows('interactions')
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({ direction: 'outbound' })
    expect(await e.rows('message_sources')).toHaveLength(1)
  })

  it('an original over 5 MiB of unknown size is stored whole, byte-identical', async () => {
    const big = bytesOf(5 * 1024 * 1024 + 123, 6)
    const built = fx('plain', (s) => ({ ...s, rawOverride: big }))
    const t = setup([built])
    await t.run(['plain'])
    const [m] = await e.rows('messages')
    const stored = await t.objects.get(`${m!.content_key}/v1/original.eml`)
    expect(stored!.size).toBe(big.byteLength)
    expect(same(await readAll(stored!.body), big)).toBe(true)
  })

  describe('attachments', () => {
    it('stored with the hash and size of the decoded bytes', async () => {
      const att = fx('attachment')
      const t = setup([att])
      await t.run(['with-attachment'])
      const [file] = await e.rows('files')
      expect(file).toMatchObject({ sha256: sha(att.attachments.get('att-pdf')!), size_bytes: 300 })
      const blob = await t.objects.get(`${file!.storage_key}/blob`)
      expect(same(await readAll(blob!.body), att.attachments.get('att-pdf')!)).toBe(true)
      expect(await e.rows('message_attachments')).toMatchObject([{ position: 0, fetch_status: 'stored', name: 'report.pdf', mime_type: 'application/pdf' }])
    })

    it('a declared size that differs from the decoded bytes: link failed (length_mismatch), no object, message captured', async () => {
      const t = setup([fx('attachment', (s) => ({ ...s, payload: { ...s.payload, parts: s.payload.parts!.map((p) => (p.bytes ? { ...p, declaredSize: 400 } : p)) } }))])
      const result = await t.run(['with-attachment'])
      expect(result).toMatchObject({ captured: 1, attachments: { stored: 0, failed: 1, skipped: 0 } })
      expect((await e.rows('message_attachments')).map((r) => [r.fetch_status, r.fetch_error, r.file_id])).toEqual([['failed', 'length_mismatch', null]])
      expect(await e.rows('files')).toHaveLength(0)
      expect(t.objects.writes.filter((w) => w.key.endsWith('/blob'))).toHaveLength(1) // written, then deleted
      expect(t.objects.deletes.filter((k) => k.endsWith('/blob'))).toHaveLength(1)
    })

    it('a failed fetch: link failed with a short code, message captured, no file', async () => {
      const t = setup([fx('attachment')])
      t.gmail.failWhen((c) => c.op === 'attachment', new GmailApiError({ status: 500, reason: 'backendError' }))
      const result = await t.run(['with-attachment'])
      expect(result).toMatchObject({ captured: 1, attachments: { stored: 0, failed: 1, skipped: 0 } })
      expect((await e.rows('message_attachments')).map((r) => [r.fetch_status, r.fetch_error])).toEqual([['failed', 'http_500']])
      expect(await e.rows('files')).toHaveLength(0)
    })

    it('over attachmentMaxBytes: skipped and not fetched', async () => {
      const t = setup([fx('attachment')], { attachmentMaxBytes: 100 })
      const result = await t.run(['with-attachment'])
      expect(result.attachments).toEqual({ stored: 0, failed: 0, skipped: 1 })
      expect(ops(t.gmail, 'attachment')).toBe(0)
      expect((await e.rows('message_attachments')).map((r) => r.fetch_status)).toEqual(['skipped'])
    })
  })

  it('a message that is gone (404) is counted as a skip and the rest of the batch is captured', async () => {
    const t = setup([fx('plain')])
    const result = await t.run(['vanished', 'plain'])
    expect(result).toMatchObject({ captured: 1, skipped: { not_found: 1 } })
  })

  it('a message without a Message-ID is captured under the fallback external id', async () => {
    const t = setup([fx('noMessageId')])
    await t.run(['no-message-id'])
    expect((await e.rows('messages')).map((r) => r.external_id)).toEqual([`gmail:${C1.id}:no-message-id`])
  })
})
