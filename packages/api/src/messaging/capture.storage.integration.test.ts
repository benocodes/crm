import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SetLimitExceeded, uuidv7 } from '@vault/storage'
import { withFault } from '@vault/storage/test'
import { ApiError, mapStorageError } from '../errors.js'
import { openEngines, type Engine, type RawRow } from '../test/engines.js'
import { captureMessage, runCapture, storedAttachment, type CaptureOverrides } from '../test/capture-kit.js'
import { recordMessages, recordMessagesOperation, type CaptureMessage } from './capture.js'

// The capture unit on both engines ([[CORE68]], spec [[CORE25]] "Capture write path" step 5). D1 is the gate; Postgres is
// reported. Every case asserts stored rows through `e.rows(table)` and events through `e.rows('events')`, never through the
// read resources (a test that seeds through the function under test cannot catch that function's bug).
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const C2 = '0190b2c4-0000-7000-8000-0000000000c2'
const NOW = '2026-10-22T10:00:00.000Z'
const CAPTURE_TABLES = ['threads', 'messages', 'files', 'message_attachments', 'interactions', 'interaction_participants', 'message_sources', 'thread_sources'] as const
const ALL_TABLES = [...CAPTURE_TABLES, 'contacts', 'identities', 'events'] as const
const settle = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err)

let engines: Engine[]
beforeAll(async () => {
  engines = await openEngines()
})
afterAll(async () => {
  for (const e of engines) await e.close()
})

describe.each(['postgres', 'd1'] as const)('recordMessages on %s', (name) => {
  let e: Engine
  beforeAll(() => {
    e = engines.find((x) => x.name === name)!
  })
  beforeEach(async () => {
    await e.reset()
  })

  const msg = (over: CaptureOverrides = {}): CaptureMessage => captureMessage(e.organizationId, over)
  const cap = (messages: CaptureMessage[], opts: { connection?: string; as?: 'user' | 'agent' } = {}) =>
    runCapture(e, { connection_id: opts.connection ?? C1, messages }, opts.as)
  const counts = async (tables: readonly string[] = ALL_TABLES) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await e.rows(t)).length] as const)))
  const types = async () => (await e.rows('events')).map((r) => r.type as string)
  const threadOf = async (m: CaptureMessage) => (await e.rows('messages')).find((r) => r.external_id === m.external_id)!.thread_id as string
  const identity = async (value: string) => (await e.rows('identities')).find((r) => r.value === value && r.deleted_at === null)!

  describe('one message', () => {
    it('writes the whole conversation and its events in order', async () => {
      const m = msg({ attachments: 1, subject: 'Hello' })
      const { value, events, stats } = await cap([m])

      const [thread] = await e.rows('threads')
      expect(await e.rows('threads')).toHaveLength(1)
      expect(thread).toMatchObject({ channel: 'email', subject: 'Hello', created_by: e.userId, created_at: NOW, organization_id: e.organizationId })

      const [message] = await e.rows('messages')
      expect(await e.rows('messages')).toHaveLength(1)
      expect(message).toMatchObject({
        thread_id: thread!.id,
        channel: 'email',
        kind: 'message',
        external_id: m.external_id,
        in_reply_to: null,
        author: m.author,
        occurred_at: m.occurred_at,
        preview: m.preview,
        content_key: m.content_key,
        version: 1,
        retracted_at: null,
        created_at: NOW,
        created_by: e.userId,
      })

      const [file] = await e.rows('files')
      expect(await e.rows('files')).toHaveLength(1)
      expect(file).toMatchObject({ storage_key: m.attachments[0]!.file!.storage_key, sha256: m.attachments[0]!.file!.sha256, name: 'file-0.pdf', mime_type: 'application/pdf', size_bytes: 1000, created_at: NOW })

      const [link] = await e.rows('message_attachments')
      expect(await e.rows('message_attachments')).toHaveLength(1)
      expect(link).toMatchObject({ message_id: message!.id, position: 0, fetch_status: 'stored', file_id: file!.id, inline: false, created_at: NOW })

      const [interaction] = await e.rows('interactions')
      expect(await e.rows('interactions')).toHaveLength(1)
      expect(interaction).toMatchObject({ kind: 'message', channel: 'email', direction: 'inbound', thread_id: thread!.id, message_id: message!.id, occurred_at: m.occurred_at, created_at: NOW })

      const jane = await identity('jane@acme.test')
      const owner = await identity('owner@vault.test')
      expect(jane).toMatchObject({ own: false, created_at: NOW })
      const participants = await e.rows('interaction_participants')
      expect(participants.map((p) => [p.role, p.identity_id, p.interaction_id])).toEqual([
        ['from', jane.id, interaction!.id],
        ['to', owner.id, interaction!.id],
      ])
      expect(participants.every((p) => p.created_at === NOW && p.created_by === e.userId)).toBe(true)

      expect(await e.rows('message_sources')).toEqual([expect.objectContaining({ message_id: message!.id, connection_id: C1, provider_message_id: m.provider_message_id, provider_thread_id: m.provider_thread_id, created_at: NOW })])
      expect(await e.rows('thread_sources')).toEqual([expect.objectContaining({ thread_id: thread!.id, connection_id: C1, provider_thread_id: m.provider_thread_id, created_at: NOW })])

      expect(await types()).toEqual(['contact.created', 'contact.created', 'identity.created', 'identity.created', 'thread.created', 'message.created', 'file.created', 'interaction.created'])
      const evs = await e.rows('events')
      expect(evs.every((r) => r.created_at === NOW && r.actor_id === e.userId && r.organization_id === e.organizationId && r.before === null)).toBe(true)
      expect(events.map((r) => r.type)).toEqual(evs.map((r) => r.type))
      const byType = (t: string) => evs.find((r) => r.type === t)!
      expect(byType('message.created').after.attachments).toEqual([
        { id: link!.id, position: 0, type: 'file', name: 'file-0.pdf', mime_type: 'application/pdf', size_bytes: 1000, inline: false, content_id: null, fetch_status: 'stored', file_id: file!.id },
      ])
      expect(byType('interaction.created').after.participants).toEqual([
        { identity_id: jane.id, role: 'from' },
        { identity_id: owner.id, role: 'to' },
      ])
      expect(byType('thread.created').resource_id).toBe(thread!.id)
      expect(byType('file.created').after).not.toHaveProperty('storage_key')

      expect(value).toEqual({
        captured: [{ external_id: m.external_id, message_id: message!.id, thread_id: thread!.id, interaction_id: interaction!.id, new_thread: true }],
        existing: [],
        duplicate_objects: [],
      })
      expect(stats.statements).toBeGreaterThan(0)
    })

    it('attributes every row and event to the calling agent', async () => {
      await cap([msg({ attachments: 1 })], { as: 'agent' })
      for (const t of ['threads', 'messages', 'files', 'message_attachments', 'interactions', 'interaction_participants', 'message_sources', 'thread_sources', 'contacts', 'identities']) {
        const rows = await e.rows(t)
        expect(rows.length, t).toBeGreaterThan(0)
        expect(rows.every((r) => r.created_by === e.agentId), t).toBe(true)
      }
      const evs = await e.rows('events')
      expect(evs.length).toBeGreaterThan(0)
      expect(evs.every((r) => r.actor_id === e.agentId)).toBe(true)
    })

    it('records a participant name as the new contact name, cleaned', async () => {
      await cap([msg({ participants: [{ kind: 'email', value: 'jane@acme.test', role: 'from', name: '  Jane  ' }] })])
      expect((await e.rows('contacts')).map((c) => c.name)).toEqual(['Jane'])
    })

    it('resolves a repeated address once and keeps both roles', async () => {
      await cap([
        msg({
          participants: [
            { kind: 'email', value: 'jane@acme.test', role: 'from' },
            { kind: 'email', value: 'bob@acme.test', role: 'to' },
            { kind: 'email', value: 'bob@acme.test', role: 'cc' },
          ],
        }),
      ])
      expect(await e.rows('identities')).toHaveLength(2)
      expect((await e.rows('interaction_participants')).map((p) => p.role).sort()).toEqual(['cc', 'from', 'to'])
    })

    it('stores a reaction without content', async () => {
      const parent = msg()
      await cap([parent])
      const r = msg({ kind: 'reaction', preview: '👍', in_reply_to: parent.external_id })
      await cap([r])
      const row = (await e.rows('messages')).find((x) => x.external_id === r.external_id)!
      expect(row).toMatchObject({ kind: 'reaction', content_key: null, preview: '👍' })
      expect((await e.rows('interactions')).find((i) => i.message_id === row.id)).toMatchObject({ kind: 'reaction' })
      expect(row.thread_id).toBe(await threadOf(parent))
    })

    it('keeps every attachment status in position order and stores a file only for the stored one', async () => {
      const base = storedAttachment(e.organizationId, 0)
      const m = msg({
        attachments: [
          { ...base, position: 3, fetch_status: 'pending', fetch_metadata: { id: 'x' }, file: null, name: 'p.bin' },
          base,
          { ...base, position: 1, fetch_status: 'failed', fetch_error: 'not found', file: null },
          { ...base, position: 2, fetch_status: 'skipped', file: null, inline: true, content_id: 'cid-1' },
        ],
      })
      await cap([m])
      const links = (await e.rows('message_attachments')).sort((a, b) => a.position - b.position)
      expect(links.map((l) => [l.position, l.fetch_status])).toEqual([[0, 'stored'], [1, 'failed'], [2, 'skipped'], [3, 'pending']])
      expect(links.map((l) => l.file_id !== null)).toEqual([true, false, false, false])
      expect(links[1]).toMatchObject({ fetch_error: 'not found' })
      expect(links[2]).toMatchObject({ inline: true, content_id: 'cid-1' })
      expect(links[3]).toMatchObject({ fetch_metadata: { id: 'x' }, name: 'p.bin' })
      expect(await e.rows('files')).toHaveLength(1)
    })

    it('derives direction from the connection, then from an own sender', async () => {
      await e.insert('identities', { kind: 'email', value: 'me@vault.test', contact_id: null, own: true })
      const sent = msg({ sent_by_connection: true, occurred_at: '2026-10-22T09:00:00.000Z' })
      const fromOwn = msg({ participants: [{ kind: 'email', value: 'me@vault.test', role: 'from' }], occurred_at: '2026-10-22T09:01:00.000Z' })
      const inbound = msg({ occurred_at: '2026-10-22T09:02:00.000Z' })
      const { value } = await cap([inbound, fromOwn, sent])
      const interactions = await e.rows('interactions')
      const direction = (m: CaptureMessage) => interactions.find((i) => i.id === value.captured.find((c) => c.external_id === m.external_id)!.interaction_id)!.direction
      expect([direction(sent), direction(fromOwn), direction(inbound)]).toEqual(['outbound', 'outbound', 'inbound'])
    })
  })

  describe('threads', () => {
    it('keeps a reply captured before its parent in its own thread (known limit)', async () => {
      const parent = msg()
      const reply = msg({ in_reply_to: parent.external_id, thread_hints: [parent.external_id] })
      await cap([reply])
      await cap([parent])
      expect(await e.rows('threads')).toHaveLength(2)
    })

    it('puts a reply listed before its parent in one chunk into one thread named after the parent', async () => {
      const parent = msg({ subject: 'The parent', occurred_at: '2026-10-22T08:00:00.000Z' })
      const reply = msg({ subject: 'Re: The parent', in_reply_to: parent.external_id, occurred_at: '2026-10-22T09:00:00.000Z' })
      const { value } = await cap([reply, parent])
      const threads = await e.rows('threads')
      expect(threads).toHaveLength(1)
      expect(threads[0]!.subject).toBe('The parent')
      expect(new Set(value.captured.map((c) => c.thread_id)).size).toBe(1)
      expect(value.captured.map((c) => c.external_id)).toEqual([parent.external_id, reply.external_id])
      expect(value.captured.map((c) => c.new_thread)).toEqual([true, false])
    })

    it('follows in_reply_to to the parent and aliases the reply pair', async () => {
      const parent = msg()
      await cap([parent])
      const reply = msg({ in_reply_to: parent.external_id })
      await cap([reply])
      const t = await threadOf(parent)
      expect(await threadOf(reply)).toBe(t)
      expect(await e.rows('threads')).toHaveLength(1)
      expect((await e.rows('thread_sources')).map((s) => [s.provider_thread_id, s.thread_id])).toEqual([[parent.provider_thread_id, t], [reply.provider_thread_id, t]])
    })

    it('follows a References-only hint', async () => {
      const parent = msg()
      await cap([parent])
      const reply = msg({ in_reply_to: null, thread_hints: [parent.external_id] })
      await cap([reply])
      expect(await threadOf(reply)).toBe(await threadOf(parent))
    })

    it('prefers the nearest hint', async () => {
      const a = msg()
      const b = msg()
      await cap([a])
      await cap([b])
      const reply = msg({ in_reply_to: null, thread_hints: [b.external_id, a.external_id] })
      await cap([reply])
      expect(await threadOf(b)).not.toBe(await threadOf(a))
      expect(await threadOf(reply)).toBe(await threadOf(b))
    })

    it('joins a split Gmail thread through the reply and aliases both provider threads', async () => {
      const m1 = msg({ provider_thread_id: 'g1' })
      await cap([m1])
      const m2 = msg({ provider_thread_id: 'g2', in_reply_to: m1.external_id })
      await cap([m2])
      const t = await threadOf(m1)
      expect(await threadOf(m2)).toBe(t)
      expect((await e.rows('thread_sources')).map((s) => [s.connection_id, s.provider_thread_id, s.thread_id])).toEqual([[C1, 'g1', t], [C1, 'g2', t]])
    })

    it('lets the pair alias win over a hint', async () => {
      const m1 = msg({ provider_thread_id: 'g1' })
      const other = msg({ provider_thread_id: 'g9' })
      await cap([m1])
      await cap([other])
      const m3 = msg({ provider_thread_id: 'g1', in_reply_to: other.external_id })
      await cap([m3])
      expect(await threadOf(m3)).toBe(await threadOf(m1))
      expect(await threadOf(other)).not.toBe(await threadOf(m1))
    })
  })

  describe('a second mailbox and re-sent messages', () => {
    it('adds sources only for a copy from another connection', async () => {
      const m = msg()
      await cap([m])
      const before = await counts()
      const eventsBefore = (await e.rows('events')).length
      const copy = { ...m, provider_message_id: 'other-pm', provider_thread_id: 'other-pt' }
      const { value } = await cap([copy], { connection: C2 })
      const message = (await e.rows('messages'))[0]!
      expect(await counts()).toEqual({ ...before, message_sources: 2, thread_sources: 2 })
      expect((await e.rows('events')).length).toBe(eventsBefore)
      expect((await e.rows('thread_sources')).map((s) => s.thread_id)).toEqual([message.thread_id, message.thread_id])
      expect((await e.rows('message_sources')).map((s) => [s.connection_id, s.message_id])).toEqual([[C1, message.id], [C2, message.id]])
      expect(value).toEqual({ captured: [], existing: [{ external_id: m.external_id, message_id: message.id }], duplicate_objects: [] })
    })

    it("reports a copy's fresh objects as duplicates and writes no file", async () => {
      const m = msg()
      await cap([m])
      const att = storedAttachment(e.organizationId, 0)
      const { value } = await cap([{ ...m, provider_message_id: 'x', provider_thread_id: 'y', attachments: [att] }], { connection: C2 })
      expect(value.duplicate_objects).toEqual([att.file!.storage_key])
      expect(await e.rows('files')).toHaveLength(0)
      expect(await e.rows('message_attachments')).toHaveLength(0)
    })

    it('treats a re-run chunk as all existing and writes nothing', async () => {
      const ms = [msg({ attachments: 1, occurred_at: '2026-10-22T09:00:00.000Z' }), msg({ attachments: 1, occurred_at: '2026-10-22T09:01:00.000Z' })]
      await cap(ms)
      const before = await counts()
      const messages = await e.rows('messages')
      const fresh = ms.map((m) => ({ ...m, attachments: [storedAttachment(e.organizationId, 0)] }))
      const { value, events, stats } = await cap(fresh)
      expect(await counts()).toEqual(before)
      expect(events).toEqual([])
      expect(value.captured).toEqual([])
      expect(value.existing).toEqual(fresh.map((m) => ({ external_id: m.external_id, message_id: messages.find((r) => r.external_id === m.external_id)!.id })))
      expect(value.duplicate_objects).toEqual(fresh.flatMap((m) => m.attachments.map((a) => a.file!.storage_key)))
      expect(stats.statements).toBe(ALL_EXISTING_STATEMENTS[name])
    })

    it('lists each existing key once, in input order', async () => {
      const x = msg({ occurred_at: '2026-10-22T09:00:00.000Z' })
      const y = msg({ occurred_at: '2026-10-22T09:01:00.000Z' })
      await cap([x, y])
      const { value } = await cap([y, x, y])
      expect(value.captured).toEqual([])
      expect(value.existing.map((r) => r.external_id)).toEqual([y.external_id, x.external_id])
    })
  })

  describe('files', () => {
    it('gives one blob in one chunk the first key and reports the other as a duplicate', async () => {
      const sha = 'ab'.repeat(32)
      const a1 = storedAttachment(e.organizationId, 0, { sha256: sha })
      const a2 = storedAttachment(e.organizationId, 0, { sha256: sha })
      const m1 = msg({ attachments: [a1], occurred_at: '2026-10-22T09:00:00.000Z' })
      const m2 = msg({ attachments: [a2], occurred_at: '2026-10-22T09:01:00.000Z' })
      const { value } = await cap([m2, m1])
      const files = await e.rows('files')
      expect(files.map((f) => f.storage_key)).toEqual([a1.file!.storage_key, a1.file!.storage_key])
      expect(files).toHaveLength(2)
      expect(value.duplicate_objects).toEqual([a2.file!.storage_key])
      expect((await e.rows('events')).filter((r) => r.type === 'file.created')).toHaveLength(2)
    })

    it('gives a blob stored by an earlier chunk its key', async () => {
      const sha = 'cd'.repeat(32)
      const first = storedAttachment(e.organizationId, 0, { sha256: sha })
      await cap([msg({ attachments: [first] })])
      const third = storedAttachment(e.organizationId, 0, { sha256: sha })
      const { value } = await cap([msg({ attachments: [third] })])
      const files = await e.rows('files')
      expect(files).toHaveLength(2)
      expect(files[1]!.storage_key).toBe(first.file!.storage_key)
      expect(value.duplicate_objects).toEqual([third.file!.storage_key])
    })
  })

  describe('shape', () => {
    const fresh = (n: number) =>
      Array.from({ length: n }, (_, i) => msg({ attachments: 1, occurred_at: `2026-10-22T09:${String(i).padStart(2, '0')}:00.000Z` }))

    it('sends a constant number of statements whatever the chunk size', async () => {
      const one = await cap(fresh(1))
      await e.reset()
      const ten = await cap(fresh(10))
      expect(ten.stats.statements).toBe(one.stats.statements)
    })

    it('rolls back everything when a statement fails after the first mutation or the first event', async () => {
      for (const after of ['first-mutation', 'first-event'] as const) {
        const op = withFault(recordMessagesOperation(e.env(), { connection_id: C1, messages: [msg({ attachments: 1 })] }), { after })
        await expect(e.run(op)).rejects.toBeDefined()
        expect(await counts(), after).toEqual(Object.fromEntries(ALL_TABLES.map((t) => [t, 0])))
      }
    })

    it('refuses an input outside the programmer contract', () => {
      const run = (m: CaptureMessage) => () => recordMessages(e.env(), { connection_id: C1, messages: [m] })
      expect(run(msg({ thread_hints: Array.from({ length: 21 }, (_, i) => `h${i}`) }))).toThrow(/thread_hints/)
      expect(run(msg({ content_key: null }))).toThrow(/content_key/)
      expect(run(msg({ kind: 'reaction', content_key: 'orgs/x' }))).toThrow(/content_key/)
      expect(run(msg({ attachments: [{ ...storedAttachment(e.organizationId, 0), file: null }] }))).toThrow(/stored/)
      expect(run(msg({ attachments: [{ ...storedAttachment(e.organizationId, 0), fetch_status: 'failed' }] }))).toThrow(/stored/)
      expect(run(msg({ participants: [{ kind: 'email', value: 'bob@x.test', role: 'to' }] }))).toThrow(/from/)
      expect(run(msg({ participants: [{ kind: 'email', value: 'Jane@X.test', role: 'from' }] }))).toThrow(/normalised/)
    })
  })

  describe.runIf(name === 'd1')('races between plan and commit (D1)', () => {
    const drift = async (input: CaptureMessage[], hook: () => Promise<void>, opts: { connection?: string } = {}) => {
      let after: Record<string, number> | null = null
      e.betweenPlanAndCommit(async () => {
        await hook()
        after = await counts()
      })
      const err = mapStorageError(await settle(cap(input, opts)))
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 409, code: 'conflict' })
      expect(after).not.toBeNull()
      expect(await counts()).toEqual(after)
    }
    const thread = (subject = 'Elsewhere') => e.insert('threads', { channel: 'email', subject })
    const rawMessage = async (m: Pick<CaptureMessage, 'external_id' | 'author'>, threadId: string) =>
      e.insert('messages', {
        thread_id: threadId,
        channel: 'email',
        kind: 'message',
        external_id: m.external_id,
        in_reply_to: null,
        author: m.author,
        occurred_at: '2026-10-22T07:00:00.000Z',
        preview: 'raced',
        content_key: `orgs/${e.organizationId}/messages/email/${'f'.repeat(64)}`,
        version: 1,
        retracted_at: null,
      })

    it('a copy committed meanwhile: sources only on retry', async () => {
      const m = msg()
      let message: RawRow
      await drift([m], async () => {
        message = await rawMessage(m, (await thread()).id)
      })
      const { value } = await cap([m])
      expect(value.captured).toEqual([])
      expect(value.existing).toEqual([{ external_id: m.external_id, message_id: message!.id }])
      expect(await e.rows('messages')).toHaveLength(1)
      expect(await e.rows('message_sources')).toHaveLength(1)
    })

    it('an ancestor appeared: the reply joins the parent thread on retry', async () => {
      const parent = msg()
      const reply = msg({ in_reply_to: parent.external_id })
      let t: RawRow
      await drift([reply], async () => {
        t = await thread()
        await rawMessage(parent, t.id)
      })
      await cap([reply])
      expect(await threadOf(reply)).toBe(t!.id)
    })

    it('a nearer ancestor appeared: the reply joins rank 0 on retry', async () => {
      const far = msg()
      await cap([far])
      const near = msg()
      const reply = msg({ in_reply_to: near.external_id, thread_hints: [far.external_id] })
      let t: RawRow
      await drift([reply], async () => {
        t = await thread()
        await rawMessage(near, t.id)
      })
      await cap([reply])
      expect(await threadOf(reply)).toBe(t!.id)
      expect(t!.id).not.toBe(await threadOf(far))
    })

    it('an alias was added: the message joins its thread on retry', async () => {
      const m = msg({ provider_thread_id: 'g1' })
      let t: RawRow
      await drift([m], async () => {
        t = await thread()
        await e.insert('thread_sources', { thread_id: t.id, connection_id: C1, provider_thread_id: 'g1' })
      })
      await cap([m])
      expect(await threadOf(m)).toBe(t!.id)
    })

    it('an alias moved with the count kept: the message joins the new thread on retry', async () => {
      const first = msg({ provider_thread_id: 'g1' })
      await cap([first])
      const m = msg({ provider_thread_id: 'g1' })
      let t2: RawRow
      await drift([m], async () => {
        t2 = await thread()
        await e.d1!.prepare('delete from thread_sources where provider_thread_id = ?').bind('g1').run()
        await e.insert('thread_sources', { thread_id: t2.id, connection_id: C1, provider_thread_id: 'g1' })
      })
      await cap([m])
      expect(await threadOf(m)).toBe(t2!.id)
    })

    it('a new blob appeared: the file takes the stored key on retry', async () => {
      const sha = 'ee'.repeat(32)
      const att = storedAttachment(e.organizationId, 0, { sha256: sha })
      const kx = `orgs/${e.organizationId}/files/${uuidv7()}`
      await drift([msg({ attachments: [att] })], async () => {
        await e.insert('files', { name: 'x', mime_type: 'application/pdf', size_bytes: 1, sha256: sha, storage_key: kx })
      })
      const { value } = await cap([msg({ attachments: [att] })])
      expect((await e.rows('files')).map((f) => f.storage_key)).toEqual([kx, kx])
      expect(value.duplicate_objects).toEqual([att.file!.storage_key])
    })

    it('an identity was created for a new address: resolve finds it on retry', async () => {
      const m = msg({ participants: [{ kind: 'email', value: 'new@x.test', role: 'from' }] })
      let raced: RawRow
      await drift([m], async () => {
        raced = await e.insert('identities', { kind: 'email', value: 'new@x.test', contact_id: (await e.insert('contacts', { name: 'Raced' })).id, own: false })
      })
      await cap([m])
      expect((await e.rows('interaction_participants'))[0]!.identity_id).toBe(raced!.id)
      expect((await e.rows('identities')).filter((i) => i.value === 'new@x.test')).toHaveLength(1)
    })

    describe('with a known sender', () => {
      let jane: RawRow
      beforeEach(async () => {
        await cap([msg()])
        jane = await identity('jane@acme.test')
      })
      const next = () => msg({ occurred_at: '2026-10-22T09:30:00.000Z' })
      const participantsOf = async (m: CaptureMessage) => {
        const id = (await e.rows('messages')).find((r) => r.external_id === m.external_id)!.id
        const interaction = (await e.rows('interactions')).find((i) => i.message_id === id)!
        return { interaction, rows: (await e.rows('interaction_participants')).filter((p) => p.interaction_id === interaction.id) }
      }

      it('a planned identity was removed: a new identity is created on retry', async () => {
        const m = next()
        await drift([m], async () => {
          await e.update('identities', jane.id, { deleted_at: NOW })
        })
        await cap([m])
        const live = await identity('jane@acme.test')
        expect(live.id).not.toBe(jane.id)
        expect((await participantsOf(m)).rows.find((p) => p.role === 'from')!.identity_id).toBe(live.id)
      })

      it('a planned identity was swapped with the count kept: the new identity is the participant on retry', async () => {
        const m = next()
        let replacement: RawRow
        await drift([m], async () => {
          await e.update('identities', jane.id, { deleted_at: NOW })
          replacement = await e.insert('identities', { kind: 'email', value: 'jane@acme.test', contact_id: (await e.insert('contacts', { name: 'Replacement' })).id, own: false })
        })
        await cap([m])
        expect((await participantsOf(m)).rows.find((p) => p.role === 'from')!.identity_id).toBe(replacement!.id)
      })

      it('the sender became own: the retry is outbound', async () => {
        const m = next()
        await drift([m], async () => {
          await e.update('identities', jane.id, { own: true, contact_id: null })
        })
        await cap([m])
        expect((await participantsOf(m)).interaction.direction).toBe('outbound')
      })

      it('a merge of the sender contact is not drift: the first run commits with the same identity', async () => {
        const m = next()
        const survivor = await e.insert('contacts', { name: 'Survivor' })
        e.betweenPlanAndCommit(async () => {
          await e.update('identities', jane.id, { contact_id: survivor.id })
        })
        await cap([m])
        const { interaction, rows } = await participantsOf(m)
        expect(interaction.direction).toBe('inbound')
        expect(rows.find((p) => p.role === 'from')!.identity_id).toBe(jane.id)
      })
    })
  })
})

// Pinned from the first green run: a chunk whose addresses and messages all exist sends the plan read batch plus the
// unit's fixed statements and none of resolve's four.
const ALL_EXISTING_STATEMENTS: Record<'postgres' | 'd1', number> = { postgres: 20, d1: 21 }

describe.each(['postgres', 'd1'] as const)('recordMessages caps on %s', (name) => {
  let capped: Engine[]
  let e: Engine
  beforeAll(async () => {
    capped = await openEngines({ maxSetSize: 3 })
    e = capped.find((x) => x.name === name)!
  })
  afterAll(async () => {
    for (const c of capped) await c.close()
  })
  beforeEach(async () => {
    await e.reset()
  })

  const refused = async (messages: CaptureMessage[]) => {
    expect(await settle(runCapture(e, { connection_id: C1, messages }))).toBeInstanceOf(SetLimitExceeded)
    for (const t of ALL_TABLES) expect((await e.rows(t)).length, t).toBe(0)
  }
  const m = (over: CaptureOverrides = {}) => captureMessage(e.organizationId, over)

  it('refuses more messages than the cap', async () => {
    await refused([m(), m(), m(), m()])
  })
  it('refuses more distinct addresses than the cap', async () => {
    await refused([m({ participants: ['a', 'b', 'c', 'd'].map((x, i) => ({ kind: 'email' as const, value: `${x}@x.test`, role: i === 0 ? ('from' as const) : ('to' as const) })) })])
  })
  it('refuses more stored attachments than the cap', async () => {
    await refused([m({ attachments: 4 })])
  })
  it('accepts a chunk at the cap', async () => {
    const { value } = await runCapture(e, { connection_id: C1, messages: [m({ attachments: 3 }), m(), m()] })
    expect(value.captured).toHaveLength(3)
  })
})
