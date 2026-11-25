import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { stripInvisibleCharacters } from '../channels/invisible-characters.js'
import { GmailChannel } from '../channels/gmail/channel.js'
import { memoryObjectStore } from '../objects/store.js'
import { ensureConnection } from '../test/capture-kit.js'
import { openEngines, type Engine } from '../test/engines.js'
import { FakeGmail } from '../test/gmail.js'
import type { MessageSpec } from '../test/gmail.js'
import { gmailFixture, MAILBOX } from '../test/gmail-fixtures.js'
import { nodeStreams } from '../test/streams.js'
import { captureMessages, type PipelineContext } from './pipeline.js'

// [[CHN193]] D4 and D1 to D3 ([[AGT588]]): what the capture pipeline stores from a real Gmail read. One test per stored field.
const NOW = '2026-10-22T10:00:00.000Z'
const C1 = { id: '0190b2c4-0000-7000-8000-0000000000c1', mailbox: MAILBOX }
const C2 = { id: '0190b2c4-0000-7000-8000-0000000000c2', mailbox: 'second@vibase.test' }
const ZW = '\u200B'
const BIDI = '\u202E'
const TAG = String.fromCodePoint(0xe0041)
const HIDE = `${ZW}${BIDI}${TAG}`
/** Whether the text holds a character the rule strips (exact results are pinned in `invisible-characters.test.ts`). */
const INVISIBLE = { test: (text: string): boolean => stripInvisibleCharacters(text) !== text }

describe('hidden content at capture, Gmail path on D1', () => {
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

  const objects = memoryObjectStore()
  const capture = async (msgs: ReturnType<typeof gmailFixture>[], conn = C1) => {
    const ctx: PipelineContext = {
      binding: e.binding,
      organizationId: e.organizationId,
      actorId: e.userId,
      objects,
      streams: nodeStreams(),
      clock: () => new Date(NOW),
      newId: () => uuidv7(new Date(NOW)),
      randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
    }
    await ensureConnection(e.binding, e, conn.id)
    return captureMessages(
      ctx,
      new GmailChannel(new FakeGmail(msgs)),
      conn,
      msgs.map((m) => m.resource.id),
    )
  }
  const withHeaders =
    (over: Record<string, string>, html?: string) =>
    (s: MessageSpec): MessageSpec => ({
      ...s,
      headers: s.headers.map(([k, v]) => [k, over[k] ?? v] as [string, string]),
      ...(html === undefined ? {} : { payload: { mimeType: 'text/html', text: html } }),
    })
  const bodyOf = async (row: Record<string, any>): Promise<string> =>
    new TextDecoder().decode(
      new Uint8Array(await new Response((await objects.get(`${row.content_key}/v1/body.md`))!.body).arrayBuffer()),
    )

  it('the thread subject (the only stored subject) and the From display name capture derives are stored clean', async () => {
    const m = gmailFixture(
      'htmlOnly',
      withHeaders({ Subject: `Inv${HIDE}oice`, From: `Jane${HIDE} Roe <jane@acme.test>` }),
    )
    await capture([m])
    const threads = await e.rows('threads')
    expect(threads.map((t) => t.subject)).toEqual(['Invoice'])
    for (const t of threads) expect(String(t.subject ?? '')).not.toSatisfy((text: string) => INVISIBLE.test(text))
    const names = (await e.rows('contacts')).map((c) => c.name)
    expect(names).toContain('Jane Roe')
    for (const n of names) expect(String(n ?? '')).not.toSatisfy((text: string) => INVISIBLE.test(text))
  })

  it('the stored author names are clean', async () => {
    await capture([gmailFixture('htmlOnly', withHeaders({ From: `Jane${HIDE} Roe <jane@acme.test>` }))])
    const author = (await e.rows('messages'))[0]!.author as Record<string, string>
    expect(author.full_name).toBe('Jane Roe')
  })

  it('the stored body, the preview and the fingerprint input carry no stripped character', async () => {
    const m = gmailFixture('htmlOnly', withHeaders({}, `<p>Pay${HIDE} now</p>`))
    await capture([m])
    const msg = (await e.rows('messages'))[0]!
    expect(msg.preview).toBe('Pay now')
    expect(await bodyOf(msg)).toBe('Pay now\n')
  })

  it('two copies differing only in stripped characters have one fingerprint: the second mailbox stores nothing new', async () => {
    const b = gmailFixture('htmlOnly', (s) =>
      withHeaders(
        { 'Message-ID': '<dup@acme.test>', Subject: `Subject of copy-b${HIDE}` },
        `<p>Same${HIDE} body</p>`,
      )({ ...s, id: 'copy-b' }),
    )
    // A's subject (the fixture default) equals B's once stripped.
    const aSame = gmailFixture('htmlOnly', (s) =>
      withHeaders(
        { 'Message-ID': '<dup@acme.test>', Subject: 'Subject of copy-b' },
        '<p>Same body</p>',
      )({ ...s, id: 'copy-a' }),
    )
    const first = await capture([aSame], C1)
    const second = await capture([b], C2)
    expect(first.captured).toBe(1)
    expect(second.captured).toBe(0)
    expect(second.existing).toBe(1)
    expect(await e.rows('messages')).toHaveLength(1)
  })

  it('a hidden element, a comment and an image URL never reach the stored body or preview (D1 to D3 through the pipeline)', async () => {
    const m = gmailFixture(
      'htmlOnly',
      withHeaders(
        {},
        '<p>Hello</p><div style="display:none">SECRET</div><!-- SECRET2 --><p><img src="https://t.test/p.gif" alt="logo"></p>',
      ),
    )
    await capture([m])
    const msg = (await e.rows('messages'))[0]!
    const body = await bodyOf(msg)
    expect(body).toBe('Hello\n\nlogo\n')
    expect(msg.preview).toBe('Hello logo')
  })

  describe('D5 the fingerprint reset', () => {
    const RESET = readFileSync(
      new URL('../../../storage-d1/migrations/0029_reset_content_sha256.sql', import.meta.url),
      'utf8',
    )
    /** A message stored before the strip shipped: its stored fingerprint is one the stripped render no longer produces. */
    const storePreStrip = async () => {
      const m = gmailFixture('htmlOnly', withHeaders({ 'Message-ID': '<old@acme.test>' }, '<p>Old body</p>'))
      await capture([m], C1)
      // messages is append-only: the test lifts the guard for its own seed and puts it back (the migration does the same for its reset).
      await e.d1!.batch([
        e.d1!.prepare('DROP TRIGGER messages_append_only'),
        e.d1!.prepare('UPDATE messages SET content_sha256 = ?').bind('ff'.repeat(32)),
        e.d1!.prepare(
          "CREATE TRIGGER messages_append_only BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'append_only'); END",
        ),
      ])
      return m
    }
    const reset = () =>
      e.d1!.batch(
        RESET.split('\n')
          .filter((l) => !l.startsWith('--'))
          .join('\n')
          .split(/;\s*\n(?=\s*(?:DROP|UPDATE|CREATE)\b)/)
          .filter((q) => q.trim() !== '')
          .map((q) => e.d1!.prepare(q)),
      )

    it('without the reset, a copy of a pre-strip message is a message of its own (the control)', async () => {
      const m = await storePreStrip()
      await capture([m], C2)
      expect(await e.rows('messages')).toHaveLength(2)
    })
    it('after the reset, a re-scan of the same mailbox and a copy in another mailbox store nothing new', async () => {
      const m = await storePreStrip()
      const eventsBefore = (await e.rows('events')).length
      await reset()
      expect((await e.rows('messages')).map((r) => r.content_sha256)).toEqual([null])
      const again = await capture([m], C1)
      const other = await capture([m], C2)
      expect(again.captured).toBe(0)
      expect(other.captured).toBe(0)
      expect(await e.rows('messages')).toHaveLength(1)
      expect((await e.rows('events')).length).toBe(eventsBefore)
    })
  })
})
