import { createHash } from 'node:crypto'
import { stringifyMarkdown } from '../channels/markdown.js'
import { describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { AttachmentFetchError, type ChannelMessage, type ConnectionRef } from '../channels/port.js'
import { bytesOf, FakeChannel, standardScripts, type FakeMessageScript } from '../test/channels.js'
import { recordingObjectStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import { memoryObjectStore } from '../objects/store.js'
import { messageContentPrefix } from './r2-keys.js'
import { storeMessageContent } from './store-content.js'

const ORG = '0190b2c4-0000-7000-8000-0000000000a1'
const CONN: ConnectionRef = { id: '0190b2c4-0000-7000-8000-0000000000c1' }
const MiB = 1024 * 1024
const text = async (store: { get(k: string): Promise<{ body: ReadableStream<Uint8Array> } | null> }, key: string) => {
  const got = await store.get(key)
  return got ? new Uint8Array(await new Response(got.body).arrayBuffer()) : null
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function setup(scripts: FakeMessageScript[], channel: FakeChannel = new FakeChannel()) {
  for (const s of scripts) channel.add(s)
  const objects = recordingObjectStore(memoryObjectStore())
  const ctx = { organizationId: ORG, objects, streams: nodeStreams(), newId: () => uuidv7() }
  const read = async (id: string) => (await channel.readMessage(CONN, id)) as ChannelMessage
  return { channel, objects, ctx, read, store: (id: string, over: Partial<typeof ctx & { attachmentMaxBytes: number }> = {}) => read(id).then((m) => storeMessageContent({ ...ctx, ...over }, channel, CONN, m)) }
}
const S = standardScripts()

describe('storeMessageContent (D6)', () => {
  it('writes body.md and the original at the CORE25 D23 keys', async () => {
    const t = setup([S.plain!])
    const m = await t.read('plain')
    const out = await storeMessageContent(t.ctx, t.channel, CONN, m)
    const prefix = await messageContentPrefix(ORG, 'email', m.facts.external_id)
    expect(out.content_key).toBe(prefix)
    expect(prefix).toMatch(new RegExp(`^orgs/${ORG}/messages/email/[0-9a-f]{64}$`))
    expect(new TextDecoder().decode((await text(t.objects, `${prefix}/v1/body.md`))!)).toBe(stringifyMarkdown(m.message.formatted))
    expect((await t.objects.get(`${prefix}/v1/body.md`))!.contentType).toBe('text/markdown')
    const original = await t.objects.get(`${prefix}/v1/original.eml`)
    expect(original!.contentType).toBe('message/rfc822')
    expect(original!.size).toBe(m.raw.size)
    expect(out.preview).toBe('Hello from plain')
    expect(out.attachments).toEqual([])
    expect(out.orphaned_objects).toBe(0)
  })

  it('stores an unknown-size original streamed whole (over 5 MiB)', async () => {
    const t = setup([S.bigOriginal!])
    const m = await t.read('big-original')
    expect(m.raw.size).toBeNull()
    const out = await storeMessageContent(t.ctx, t.channel, CONN, m)
    const stored = await text(t.objects, `${out.content_key}/v1/original.eml`)
    expect(stored!.byteLength).toBe(5 * MiB + 123)
    expect(sha(stored!)).toBe(sha(bytesOf(5 * MiB + 123)))
  })

  it('a known-size original delivered as bytes is stored as is', async () => {
    const t = setup([{ providerMessageId: 'json', raw: { ext: 'json', bytes: new TextEncoder().encode('{"a":1}') } }])
    const out = await t.store('json')
    expect(new TextDecoder().decode((await text(t.objects, `${out.content_key}/v1/original.json`))!)).toBe('{"a":1}')
  })

  it('stores an attachment: hash and size match the bytes, fresh blob key, declared name and type', async () => {
    const bytes = bytesOf(300)
    const t = setup([S.withAttachment!])
    const out = await t.store('with-attachment')
    const [a] = out.attachments
    expect(a).toMatchObject({ position: 0, type: 'file', name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 300, inline: false, content_id: null, fetch_status: 'stored', fetch_error: null, fetch_metadata: { key: 'with-attachment:0' } })
    expect(a!.file).toMatchObject({ sha256: sha(bytes), size_bytes: 300, name: 'a.pdf', mime_type: 'application/pdf' })
    expect(a!.file!.storage_key).toMatch(new RegExp(`^orgs/${ORG}/files/[0-9a-f-]{36}$`))
    expect([...(await text(t.objects, `${a!.file!.storage_key}/blob`))!]).toEqual([...bytes])
    expect((await t.objects.get(`${a!.file!.storage_key}/blob`))!.contentType).toBe('application/pdf')
  })

  it('an attachment with no name or type gets attachment-<position> and application/octet-stream', async () => {
    const t = setup([{ providerMessageId: 'anon', attachments: [{ bytes: bytesOf(5) }, { bytes: bytesOf(6) }] }])
    const out = await t.store('anon')
    expect(out.attachments.map((a) => [a.position, a.name, a.mime_type, a.file?.name, a.file?.mime_type])).toEqual([
      [0, null, null, 'attachment-0', 'application/octet-stream'],
      [1, null, null, 'attachment-1', 'application/octet-stream'],
    ])
  })

  it('skips by declared size without fetching', async () => {
    const t = setup([S.hugeAttachment!])
    const out = await t.store('huge-attachment')
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'skipped', file: null, size_bytes: 60 * MiB, fetch_metadata: { key: 'huge-attachment:0' } })
    expect(t.channel.fetches).toEqual([])
    expect(t.objects.writes.some((w) => w.key.includes('/files/'))).toBe(false)
  })

  it('honours attachmentMaxBytes from the context', async () => {
    const t = setup([S.withAttachment!])
    const out = await t.store('with-attachment', { attachmentMaxBytes: 299 })
    expect(out.attachments[0]!.fetch_status).toBe('skipped')
    expect(t.channel.fetches).toEqual([])
  })

  it('skips by fetched size: the body is cancelled and nothing is stored', async () => {
    let cancelled = false
    class Spy extends FakeChannel {
      override async fetchAttachment(conn: ConnectionRef, metadata: Record<string, string>) {
        const got = await super.fetchAttachment(conn, metadata)
        const reader = got.body.getReader()
        return { size: got.size, body: new ReadableStream<Uint8Array>({ pull: async (c) => { const r = await reader.read(); r.done ? c.close() : c.enqueue(r.value) }, cancel: () => { cancelled = true } }) }
      }
    }
    const t = setup([S.hugeFetched!], new Spy())
    const out = await t.store('huge-fetched')
    expect(t.channel.fetches).toHaveLength(1)
    expect(cancelled).toBe(true)
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'skipped', file: null, size_bytes: 60 * MiB })
    expect(t.objects.writes.some((w) => w.key.includes('/files/'))).toBe(false)
  })

  it('failed with the AttachmentFetchError code, and no provider text is stored', async () => {
    const t = setup([S.failingAttachment!])
    const out = await t.store('failing-attachment')
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'failed', fetch_error: 'not_found', file: null })
    expect(JSON.stringify(out)).not.toContain('secret-token')
  })

  it('failed with fetch_failed for any other error, and no provider text is stored', async () => {
    const t = setup([S.brokenAttachment!])
    const out = await t.store('broken-attachment')
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'failed', fetch_error: 'fetch_failed', file: null })
    expect(JSON.stringify(out)).not.toContain('token=abc')
  })

  it('a body that errors while it is read is failed with fetch_failed, not thrown', async () => {
    class Broken extends FakeChannel {
      override async fetchAttachment() {
        let sent = false
        return { size: 100, body: new ReadableStream<Uint8Array>({ pull(c) { if (sent) return c.error(new Error('reset by peer')); sent = true; c.enqueue(bytesOf(10)) } }) }
      }
    }
    const t = setup([{ providerMessageId: 'cut', attachments: [{ bytes: bytesOf(100) }] }], new Broken())
    const out = await t.store('cut')
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'failed', fetch_error: 'fetch_failed', file: null })
  })

  it.each([
    ['fewer bytes than reported', S.mismatch!],
    ['more bytes than reported', { providerMessageId: 'long', attachments: [{ bytes: bytesOf(100), reportedSize: 60 }] }],
  ])('length_mismatch (%s): failed and the fresh object is deleted', async (_n, script) => {
    const t = setup([script])
    const out = await t.store(script.providerMessageId)
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'failed', fetch_error: 'length_mismatch', file: null })
    const written = t.objects.writes.filter((w) => w.key.includes('/files/')).map((w) => w.key)
    expect(written).toHaveLength(1)
    expect(await t.objects.get(written[0]!)).toBeNull()
    expect(out.orphaned_objects).toBe(0)
  })

  it('a length mismatch whose delete fails is counted as an orphaned object', async () => {
    const t = setup([S.mismatch!])
    t.objects.failDeletes((k) => k.includes('/files/'))
    const out = await t.store('mismatch')
    expect(out.attachments[0]).toMatchObject({ fetch_status: 'failed', fetch_error: 'length_mismatch' })
    expect(out.orphaned_objects).toBe(1)
  })

  it('an object-store failure throws instead of recording failed', async () => {
    for (const [what, match] of [
      ['the blob', (k: string) => k.endsWith('/blob')],
      ['body.md', (k: string) => k.endsWith('/body.md')],
      ['the original', (k: string) => k.includes('/original.')],
    ] as const) {
      const t = setup([S.withAttachment!])
      t.objects.failWrites(match)
      await expect(t.store('with-attachment'), what).rejects.toThrow('object store down')
    }
  })

  it('a reaction stores nothing and previews its emoji', async () => {
    const t = setup([S.reaction!])
    const m = await t.read('reaction')
    const out = await storeMessageContent(t.ctx, t.channel, CONN, m)
    expect(out).toEqual({ content_key: null, preview: '👍', attachments: [], orphaned_objects: 0 })
    expect(t.objects.writes).toEqual([])
    expect(t.channel.opens).toEqual([])
  })

  it('attachments are stored in position order and the keys are deterministic across retries', async () => {
    const t = setup([{ providerMessageId: 'two', attachments: [{ name: 'b', bytes: bytesOf(3, 1) }, { name: 'c', bytes: bytesOf(4, 2) }] }])
    const first = await t.store('two')
    const second = await t.store('two')
    expect(first.attachments.map((a) => a.name)).toEqual(['b', 'c'])
    expect(second.content_key).toBe(first.content_key)
    expect(t.channel.fetches.map((f) => f.metadata.key)).toEqual(['two:0', 'two:1', 'two:0', 'two:1'])
  })

  it('AttachmentFetchError carries its code', () => {
    expect(new AttachmentFetchError('forbidden').code).toBe('forbidden')
  })
})
