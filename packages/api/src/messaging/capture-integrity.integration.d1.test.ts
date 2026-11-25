import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7, type StorageBinding } from '@vibase/storage'
import { memoryObjectStore } from '../objects/store.js'
import { FakeChannel, type FakeMessageScript } from '../test/channels.js'
import { captureMessage, ensureConnection, runCapture } from '../test/capture-kit.js'
import { openEngines, type Engine } from '../test/engines.js'
import { nodeStreams } from '../test/streams.js'
import { captureMessages, type PipelineContext } from './pipeline.js'

// [[CORE574]]: capture integrity. D5 (direction comes from the connection, never from the From address) and D6/D7 (a reused
// Message-ID with different content is a message of its own). The pipeline runs over FakeChannel on D1; assertions read raw rows.
const NOW = '2026-10-22T10:00:00.000Z'
const C1 = { id: '0190b2c4-0000-7000-8000-0000000000c1' }
const C2 = { id: '0190b2c4-0000-7000-8000-0000000000c2' }
const DUP = '<dup@x.test>'
const fallback = (conn: { id: string }, pid: string) => `gmail:${conn.id}:${pid}`
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const A: FakeMessageScript = {
  providerMessageId: 'pid-a',
  externalId: DUP,
  subject: 'Quarterly numbers',
  markdown: 'The first mail',
  from: 'jane@acme.test',
  to: ['a1@x.test'],
  occurredAt: '2026-10-22T09:00:00.000Z',
}
/** Reuses A's Message-ID with other content. */
const B: FakeMessageScript = {
  providerMessageId: 'pid-b',
  externalId: DUP,
  subject: 'Something else entirely',
  markdown: 'A different mail with a reused id',
  from: 'mallory@evil.test',
  to: ['b1@x.test'],
  occurredAt: '2026-10-22T09:01:00.000Z',
}

describe('capture integrity on d1', () => {
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
    await ensureConnection(e.binding, e, C1.id)
    await ensureConnection(e.binding, e, C2.id)
  })

  function setup(scripts: FakeMessageScript[], over: Partial<PipelineContext> = {}, binding?: StorageBinding) {
    const channel = new FakeChannel(scripts)
    const objects = over.objects ?? memoryObjectStore()
    const ctx: PipelineContext = {
      binding: binding ?? e.binding,
      organizationId: e.organizationId,
      actorId: e.userId,
      objects,
      streams: nodeStreams(),
      clock: () => new Date(NOW),
      newId: () => uuidv7(new Date(NOW)),
      randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
      ...over,
    }
    const run = (ids: string[], conn: { id: string } = C1) => captureMessages(ctx, channel, conn, ids)
    return { channel, objects, ctx, run }
  }
  const messages = () => e.rows('messages')
  const byExternal = async (external: string) => (await messages()).find((r) => r.external_id === external)
  const textAt = async (
    objects: { get(k: string): Promise<{ body: ReadableStream<Uint8Array> } | null> },
    key: string,
  ) => {
    const got = await objects.get(key)
    return got === null ? null : await new Response(got.body).text()
  }
  const bodyOf = async (objects: Parameters<typeof textAt>[0], row: Record<string, any> | undefined) =>
    textAt(objects, `${row!.content_key}/v1/body.md`)
  const snapshot = async (row: Record<string, any> | undefined) => ({
    row,
    sources: (await e.rows('message_sources')).filter((s) => s.message_id === row!.id),
    interactions: (await e.rows('interactions')).filter((i) => i.message_id === row!.id),
  })

  describe('D5 direction', () => {
    const own = async () => {
      await e.insert('identities', { kind: 'email', value: 'me@vibase.test', contact_id: null, own: true })
    }
    const directionOf = async (external: string) => {
      const row = (await messages()).find((m) => m.external_id === external)!
      return (await e.rows('interactions')).find((i) => i.message_id === row.id)!.direction
    }
    it('a From that is an own identity, without the sent flag, is inbound; with it, outbound', async () => {
      await own()
      const spoofed: FakeMessageScript = { providerMessageId: 'spoofed', from: 'me@vibase.test', to: ['victim@x.test'] }
      const sent: FakeMessageScript = { providerMessageId: 'sent', from: 'me@vibase.test', sentByConnection: true }
      const t = setup([spoofed, sent])
      await t.run(['spoofed', 'sent'])
      expect(await directionOf('<spoofed@fake.test>')).toBe('inbound')
      expect(await directionOf('<sent@fake.test>')).toBe('outbound')
    })

    it('a stored own address gives no direction to the retry either: the unit takes no part in it', async () => {
      await own()
      const m = captureMessage(e.organizationId, {
        participants: [{ kind: 'email', value: 'me@vibase.test', role: 'from' }],
      })
      await runCapture(e, { source: { kind: 'connection', id: C1.id }, channel: 'email', messages: [m] })
      expect((await e.rows('interactions'))[0]!.direction).toBe('inbound')
      const sent = captureMessage(e.organizationId, { sent_by_connection: true })
      await runCapture(e, { source: { kind: 'connection', id: C1.id }, channel: 'email', messages: [sent] })
      const sentRow = (await messages()).find((r) => r.external_id === sent.external_id)!
      expect((await e.rows('interactions')).find((i) => i.message_id === sentRow.id)!.direction).toBe('outbound')
    })

    it('the caller may say outbound', async () => {
      const m = captureMessage(e.organizationId, { direction: 'outbound' })
      await runCapture(e, { source: { kind: 'connection', id: C1.id }, channel: 'email', messages: [m] })
      expect((await e.rows('interactions'))[0]!.direction).toBe('outbound')
    })
  })

  describe('D6 collision at every decision site', () => {
    const expectTwoMessages = async (t: ReturnType<typeof setup>, conn = C1) => {
      const rows = await messages()
      expect(rows.map((r) => r.external_id).sort()).toEqual([DUP, fallback(conn, 'pid-b')].sort())
      const first = rows.find((r) => r.external_id === DUP)!
      const second = rows.find((r) => r.external_id === fallback(conn, 'pid-b'))!
      expect(await bodyOf(t.objects, first)).toContain('The first mail')
      expect(await bodyOf(t.objects, second)).toContain('A different mail with a reused id')
      const sources = await e.rows('message_sources')
      expect(sources.filter((s) => s.message_id === first.id).map((s) => s.provider_message_id)).toEqual(['pid-a'])
      expect(sources.filter((s) => s.message_id === second.id).map((s) => s.provider_message_id)).toEqual(['pid-b'])
      return { first, second }
    }

    it('(a) the first stored by an earlier page: the second is its own message and the first is untouched', async () => {
      const t = setup([A, B])
      await t.run(['pid-a'])
      const first = await snapshot(await byExternal(DUP))
      const out = await t.run(['pid-b'])
      expect(out).toMatchObject({ captured: 1, existing: 0 })
      await expectTwoMessages(t)
      expect(await snapshot(await byExternal(DUP))).toEqual(first)
      expect((await e.rows('interactions')).length).toBe(2)
    })

    it('(b) both in one chunk', async () => {
      const t = setup([A, B])
      const out = await t.run(['pid-a', 'pid-b'])
      expect(out).toMatchObject({ captured: 2, existing: 0 })
      await expectTwoMessages(t)
    })

    it('(b) both in one chunk, the colliding mail read first', async () => {
      const t = setup([A, { ...B, occurredAt: '2026-10-22T08:00:00.000Z' }])
      await t.run(['pid-b', 'pid-a'])
      // input order decides who keeps the Message-ID: the first read
      const rows = await messages()
      expect(rows.map((r) => r.external_id).sort()).toEqual([DUP, fallback(C1, 'pid-a')].sort())
    })

    it('(c) the first in an earlier chunk of the same page', async () => {
      // cap 2 and four distinct addresses: each message is a chunk of its own
      const t = setup(
        [
          { ...A, to: ['a2@x.test'] },
          { ...B, to: ['b2@x.test'] },
        ],
        { cap: 2 },
      )
      const out = await t.run(['pid-a', 'pid-b'])
      expect(out).toMatchObject({ captured: 2, existing: 0 })
      await expectTwoMessages(t)
    })

    it('(d) the first landed between the pre-check and the record, seen by the unit read: the retry decides again', async () => {
      const objects = memoryObjectStore()
      const first = setup([A], { objects })
      let landed = false
      const wrapped: StorageBinding = {
        ...e.binding,
        runtime: {
          ...e.binding.runtime,
          execute: (async (identity: any, op: any) => {
            if (op.name === 'capture.record' && !landed) {
              landed = true
              await first.run(['pid-a'], C2)
            }
            return e.binding.runtime.execute(identity, op)
          }) as typeof e.binding.runtime.execute,
        },
      }
      const t = setup([B], { objects }, wrapped)
      const out = await t.run(['pid-b'])
      expect(landed).toBe(true)
      expect(out).toMatchObject({ captured: 1, existing: 0 })
      const rows = await messages()
      expect(rows.map((r) => r.external_id).sort()).toEqual([DUP, fallback(C1, 'pid-b')].sort())
      expect(
        await bodyOf(
          objects,
          rows.find((r) => r.external_id === DUP),
        ),
      ).toContain('The first mail')
      expect(
        await bodyOf(
          objects,
          rows.find((r) => r.external_id === fallback(C1, 'pid-b')),
        ),
      ).toContain('A different mail with a reused id')
      expect((await e.rows('message_sources')).map((s) => s.provider_message_id).sort()).toEqual(['pid-a', 'pid-b'])
    })

    it('(d) the first landed after the unit planned, seen only by the commit assertion: the retry decides again', async () => {
      const objects = memoryObjectStore()
      const first = setup([A], { objects })
      let landed = false
      const wrapped: StorageBinding = {
        ...e.binding,
        runtime: {
          ...e.binding.runtime,
          execute: (async (identity: any, op: any) => {
            if (op.name === 'capture.record' && !landed) {
              landed = true
              e.betweenPlanAndCommit(async () => {
                await first.run(['pid-a'], C2)
              })
            }
            return e.binding.runtime.execute(identity, op)
          }) as typeof e.binding.runtime.execute,
        },
      }
      const t = setup([B], { objects }, wrapped)
      const out = await t.run(['pid-b'])
      expect(out).toMatchObject({ captured: 1, existing: 0 })
      const rows = await messages()
      expect(rows.map((r) => r.external_id).sort()).toEqual([DUP, fallback(C1, 'pid-b')].sort())
      expect(
        await bodyOf(
          objects,
          rows.find((r) => r.external_id === DUP),
        ),
      ).toContain('The first mail')
      expect(
        await bodyOf(
          objects,
          rows.find((r) => r.external_id === fallback(C1, 'pid-b')),
        ),
      ).toContain('A different mail with a reused id')
    })
  })

  describe('D6 matches and the empty state', () => {
    it('the same mail seen in two mailboxes is one message with two sources', async () => {
      const t = setup([A])
      await t.run(['pid-a'], C1)
      const out = await t.run(['pid-a'], C2)
      expect(out).toMatchObject({ captured: 0, existing: 1 })
      expect(await messages()).toHaveLength(1)
      expect((await e.rows('message_sources')).map((s) => s.connection_id).sort()).toEqual([C1.id, C2.id].sort())
    })

    it('a stored row with a null fingerprint matches anything: an old message does not split', async () => {
      const old = captureMessage(e.organizationId, { external_id: DUP })
      await runCapture(e, { source: { kind: 'connection', id: C1.id }, channel: 'email', messages: [old] })
      expect((await messages())[0]!.content_sha256).toBeNull()
      const t = setup([B])
      const out = await t.run(['pid-b'], C2)
      expect(out).toMatchObject({ captured: 0, existing: 1 })
      expect(await messages()).toHaveLength(1)
    })

    it('a re-scan of a collided mail is existing, with no third message', async () => {
      const t = setup([A, B])
      await t.run(['pid-a', 'pid-b'])
      const before = await e.rows('message_sources')
      const out = await t.run(['pid-a', 'pid-b'])
      expect(out).toMatchObject({ captured: 0, existing: 2 })
      expect(await messages()).toHaveLength(2)
      expect(await e.rows('message_sources')).toHaveLength(before.length)
    })

    it('P4: the fallback row exists with another fingerprint, the mail is existing whatever the fingerprints say', async () => {
      const t = setup([A, B])
      await t.run(['pid-a'])
      const seeded = captureMessage(e.organizationId, {
        external_id: fallback(C1, 'pid-b'),
        provider_message_id: 'pid-b',
        content_sha256: sha('something else altogether'),
      })
      await runCapture(e, { source: { kind: 'connection', id: C1.id }, channel: 'email', messages: [seeded] })
      const out = await t.run(['pid-b'])
      expect(out).toMatchObject({ captured: 0, existing: 1 })
      expect(await messages()).toHaveLength(2)
    })

    it('a reaction is unaffected: it stores no fingerprint and matches an existing id', async () => {
      const t = setup([A, { providerMessageId: 'react', kind: 'reaction', externalId: DUP, markdown: '👍' }])
      await t.run(['pid-a'])
      const out = await t.run(['react'])
      expect(out).toMatchObject({ captured: 0, existing: 1 })
      expect(await messages()).toHaveLength(1)
      const alone = setup([
        { providerMessageId: 'solo-react', kind: 'reaction', externalId: '<r@x.test>', markdown: '👍' },
      ])
      await alone.run(['solo-react'])
      expect((await byExternal('<r@x.test>'))!.content_sha256).toBeNull()
    })
  })

  describe('D7, P1, P2 the stored value', () => {
    it('is the SHA-256 of [subject, from address, markdown body] as JSON, recomputed from the fixture', async () => {
      const t = setup([A])
      await t.run(['pid-a'])
      const row = await byExternal(DUP)
      const body = (await bodyOf(t.objects, row))!
      expect(body).toContain('The first mail')
      expect(row!.content_sha256).toBe(sha(JSON.stringify(['Quarterly numbers', 'jane@acme.test', body])))
    })

    it('a null subject and an empty subject give different digests', async () => {
      const t = setup([
        { providerMessageId: 'n', externalId: '<n@x.test>', subject: null },
        { providerMessageId: 'e', externalId: '<e@x.test>', subject: '' },
      ])
      await t.run(['n', 'e'])
      const n = (await byExternal('<n@x.test>'))!.content_sha256
      const empty = (await byExternal('<e@x.test>'))!.content_sha256
      expect(n).toMatch(/^[0-9a-f]{64}$/)
      expect(empty).toMatch(/^[0-9a-f]{64}$/)
      expect(n).not.toBe(empty)
    })
  })
})
