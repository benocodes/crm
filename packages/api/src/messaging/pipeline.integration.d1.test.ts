import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CommitOutcomeUnknown, readSet, step, UnitDriftError, uuidv7, unit, type PreparedOperation, type StatementLabel } from '@vault/storage'
import { withFault } from '@vault/storage/test'
import type { Program } from '../identity/program.js'
import { memoryObjectStore } from '../objects/store.js'
import { bytesOf, FakeChannel, standardScripts, type FakeMessageScript } from '../test/channels.js'
import { captureMessage, runCapture, storedAttachment } from '../test/capture-kit.js'
import { openEngines, type Engine } from '../test/engines.js'
import { recordingObjectStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import { captureMessages, type PipelineContext } from './pipeline.js'

// The content pipeline on D1 ([[CORE69]] D8-D12), driven by FakeChannel. Assertions read raw rows through `e.rows`, never
// through the read resources, and writes are counted at the storage runtime, so the tests see what the pipeline did.
const NOW = '2026-10-22T10:00:00.000Z'
const C1 = { id: '0190b2c4-0000-7000-8000-0000000000c1' }
const C2 = { id: '0190b2c4-0000-7000-8000-0000000000c2' }
const S = standardScripts()
const TABLES = ['threads', 'messages', 'files', 'message_attachments', 'interactions', 'interaction_participants', 'message_sources', 'thread_sources', 'events', 'tasks'] as const

interface Faults {
  /** Throw `UnitDriftError` from the capture unit's build on these 1-based executions. */
  drift?: (n: number) => boolean
  unknown?: (n: number) => boolean
  /** Splice a real constraint fault after this statement on these 1-based executions. */
  fault?: (n: number, total: number) => StatementLabel | null
}

function engineSuite(): void {
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

  /** The engine's binding with every execution logged (operation name and statement count) and the chosen faults injected. */
  function instrument(faults: Faults = {}, totalCaptureUnits = 0) {
    const log: Array<{ name: string; steps: number }> = []
    let n = 0
    const runtime = {
      ...e.binding.runtime,
      execute: ((identity: any, op: PreparedOperation<unknown>) => {
        let prepared = op
        if (op.name === 'capture.record') {
          n++
          if (faults.unknown?.(n)) return Promise.reject(new CommitOutcomeUnknown(op.name, new Error('lost')))
          const after = faults.fault?.(n, totalCaptureUnits) ?? null
          if (after) prepared = withFault(prepared, { after })
        }
        const inner = prepared
        const at = n
        prepared = {
          ...inner,
          build: (found, qc) => {
            const built = inner.build(found, qc)
            log.push({ name: op.name, steps: built.steps.length })
            if (op.name === 'capture.record' && faults.drift?.(at)) throw new UnitDriftError(op.name)
            return built
          },
        }
        return e.binding.runtime.execute(identity, prepared)
      }) as typeof e.binding.runtime.execute,
    }
    return { binding: { ...e.binding, runtime } as typeof e.binding, log, captureUnits: () => log.filter((l) => l.name === 'capture.record') }
  }

  function setup(scripts: FakeMessageScript[], faults: Faults = {}, over: Partial<PipelineContext> = {}, totalCaptureUnits = 0) {
    const channel = new FakeChannel(scripts)
    const objects = recordingObjectStore(memoryObjectStore())
    const probe = instrument(faults, totalCaptureUnits)
    const ctx: PipelineContext = {
      binding: probe.binding,
      organizationId: e.organizationId,
      actorId: e.userId,
      objects,
      streams: nodeStreams(),
      clock: () => new Date(NOW),
      newId: () => uuidv7(new Date(NOW)),
      randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
      ...over,
    }
    const run = (ids: string[], opts: { final?: Program<unknown>; conn?: { id: string } } = {}) =>
      captureMessages(ctx, channel, opts.conn ?? C1, ids, opts.final === undefined ? undefined : { final: opts.final })
    return { channel, objects, ctx, probe, run }
  }
  /** Messages with their own two addresses each, so with `cap: 2` every message is a chunk of its own. */
  const solo = (i: number): FakeMessageScript => ({ providerMessageId: `solo-${i}`, from: `from${i}@solo.test`, to: [`to${i}@solo.test`] })
  const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await e.rows(t)).length] as const)))

  /** A stand-in for a caller's own bookkeeping (CHN5's cursor): inserts one task. Labels are given so the composition must strip them. */
  const finalInsert = (title = 'final ran', reads: Record<string, string> = {}): Program<unknown> => ({
    reads: (qc) => Object.fromEntries(Object.entries({ 'final:count': 'select count(*) as n from "tasks"', ...reads }).map(([k, q]) => [k, readSet(sql.raw(q).compile(qc.db))])),
    build: (_found, qc) =>
      unit({
        steps: [
          step(sql`insert into "tasks" ("id", "organization_id", "title", "status", "created_by", "created_at", "updated_at") values (${uuidv7()}, ${e.organizationId}, ${title}, 'open', ${e.userId}, ${NOW}, ${NOW})`.compile(qc.db), 'first-mutation'),
          step(sql`select 1 as one`.compile(qc.db), 'result'),
        ],
        events: [],
        decode: () => 'ignored',
      }),
  })

  describe('new messages', () => {
    it('captures messages with rows and events, content in the store, and a plain-count result', async () => {
      const t = setup([S.plain!, S.withAttachment!, S.reaction!])
      const result = await t.run(['plain', 'with-attachment', 'reaction'])
      expect(result).toEqual({ captured: 3, existing: 0, skipped: {}, attachments: { stored: 1, failed: 0, skipped: 0 }, orphaned_objects: 0 })
      const c = await counts()
      expect(c).toMatchObject({ messages: 3, interactions: 3, files: 1, message_attachments: 1, message_sources: 3, threads: 2 })  // the reaction joins `plain`'s thread
      const types = (await e.rows('events')).map((r) => r.type as string)
      expect(types.filter((x) => x === 'message.created')).toHaveLength(3)
      expect(types.filter((x) => x === 'file.created')).toHaveLength(1)
      const messages = await e.rows('messages')
      const withAtt = messages.find((m) => m.external_id === '<with-attachment@fake.test>')!
      expect(withAtt.preview).toBe('Hello from with-attachment')
      expect(await t.objects.get(`${withAtt.content_key}/v1/body.md`)).not.toBeNull()
      expect(await t.objects.get(`${withAtt.content_key}/v1/original.eml`)).not.toBeNull()
      const [file] = await e.rows('files')
      expect(await t.objects.get(`${file!.storage_key}/blob`)).not.toBeNull()
      const reaction = messages.find((m) => m.kind === 'reaction')!
      expect(reaction).toMatchObject({ content_key: null, preview: '👍' })
    })

    it('records attachment outcomes: stored, failed (code only) and skipped', async () => {
      const t = setup([{ providerMessageId: 'mix', attachments: [S.withAttachment!.attachments![0]!, S.failingAttachment!.attachments![0]!, S.hugeAttachment!.attachments![0]!, S.mismatch!.attachments![0]!] }])
      const result = await t.run(['mix'])
      expect(result.attachments).toEqual({ stored: 1, failed: 2, skipped: 1 })
      const rows = await e.rows('message_attachments')
      expect(rows.map((r) => [r.position, r.fetch_status, r.fetch_error])).toEqual([[0, 'stored', null], [1, 'failed', 'not_found'], [2, 'skipped', null], [3, 'failed', 'length_mismatch']])
    })

    it('a reply that arrives before its parent lands in the parent thread', async () => {
      const t = setup([S.reply!, S.parent!])
      const result = await t.run(['reply', 'parent'])
      expect(result.captured).toBe(2)
      const messages = await e.rows('messages')
      expect(new Set(messages.map((m) => m.thread_id)).size).toBe(1)
      expect(await e.rows('threads')).toHaveLength(1)
    })

    it('drops a non-ASCII address, counts it, and still captures the message', async () => {
      const t = setup([S.nonAscii!])
      const result = await t.run(['non-ascii'])
      expect(result).toMatchObject({ captured: 1, skipped: { dropped_address: 1 } })
      expect((await e.rows('interaction_participants')).length).toBe(2)
    })

    it('counts every skip reason', async () => {
      const t = setup([S.plain!, S.skipped!, S.noSender!, S.overCap!])
      const result = await t.run(['plain', 'skipped', 'no-sender', 'over-cap'])
      expect(result.captured).toBe(1)
      expect(result.skipped).toEqual({ draft: 1, unsupported_sender: 1, dropped_address: 1, too_many_participants: 1 })
      expect(t.objects.writes.every((w) => !w.key.includes('over-cap'))).toBe(true)
      expect(await counts()).toMatchObject({ messages: 1 })
    })

    it('a message with more stored attachments than the cap is skipped as too_many_attachments, before anything is stored', async () => {
      const three = { providerMessageId: 'three', attachments: [0, 1, 2].map((i) => ({ name: `f${i}`, bytes: bytesOf(5, i) })) }
      const t = setup([three, S.plain!], {}, { cap: 2 })
      const result = await t.run(['three', 'plain'])
      expect(result.skipped).toEqual({ too_many_attachments: 1 })
      expect(result.captured).toBe(1)
      expect(t.channel.fetches).toEqual([])
    })

    it('chunks by stored attachments, and an existing message contributes none', async () => {
      const two = { providerMessageId: 'two', attachments: [0, 1].map((i) => ({ name: `f${i}`, bytes: bytesOf(5, i) })) }
      const more = { providerMessageId: 'more', attachments: [0, 1].map((i) => ({ name: `g${i}`, bytes: bytesOf(6, i + 10) })) }
      const t = setup([two, more, S.plain!], {}, { cap: 2 })
      await t.run(['two'])
      expect(t.probe.captureUnits()).toHaveLength(1)
      // `two` now exists (2 attachments, would fill a chunk); `more` needs 2. One chunk if `two` counts for nothing.
      const result = await t.run(['two', 'more'])
      expect(t.probe.captureUnits()).toHaveLength(2)
      expect(result).toMatchObject({ captured: 1, existing: 1 })
      // Two new messages of two attachments each need two chunks.
      await e.reset()
      const t2 = setup([two, more], {}, { cap: 2 })
      await t2.run(['two', 'more'])
      expect(t2.probe.captureUnits()).toHaveLength(2)
    })
  })

  describe('existing messages fetch nothing', () => {
    it('a second capture of the same batch opens no raw, fetches no attachment, writes no object and no row', async () => {
      const t = setup([S.withAttachment!, S.plain!])
      await t.run(['with-attachment', 'plain'])
      const before = { opens: [...t.channel.opens], fetches: t.channel.fetches.length, writes: t.objects.writes.length, counts: await counts() }
      const result = await t.run(['with-attachment', 'plain'])
      expect(result).toMatchObject({ captured: 0, existing: 2, attachments: { stored: 0, failed: 0, skipped: 0 } })
      expect(t.channel.opens).toEqual(before.opens)
      expect(t.channel.fetches).toHaveLength(before.fetches)
      expect(t.objects.writes).toHaveLength(before.writes)
      expect(await counts()).toEqual(before.counts)
    })

    it('the same messages seen through a second connection write sources only', async () => {
      const t = setup([S.withAttachment!, S.plain!])
      await t.run(['with-attachment', 'plain'])
      const before = await counts()
      const fetchesBefore = t.channel.fetches.length
      const opensBefore = t.channel.opens.length
      const writesBefore = t.objects.writes.length
      await t.run(['with-attachment', 'plain'], { conn: C2 })
      const after = await counts()
      expect(after).toEqual({ ...before, message_sources: before.message_sources! + 2, thread_sources: before.thread_sources! + 2 })
      expect(t.channel.fetches).toHaveLength(fetchesBefore)
      expect(t.channel.opens).toHaveLength(opensBefore)
      expect(t.objects.writes).toHaveLength(writesBefore)
    })
  })

  describe('the final seam', () => {
    it('is committed in the last chunk, and a failure of that unit leaves neither its rows nor the final write', async () => {
      // cap 2 and two private addresses per message -> three chunks; fault the third unit.
      const t = setup([solo(1), solo(2), solo(3)], { fault: (n) => (n === 3 ? 'first-event' : null) }, { cap: 2 })
      await expect(t.run(['solo-1', 'solo-2', 'solo-3'], { final: finalInsert() })).rejects.toThrow()
      const c = await counts()
      expect(c.messages).toBe(2) // the first two chunks committed
      expect(c.tasks).toBe(0) // and `final` did not ride with them
    })

    it('commits with the last chunk on success, exactly once', async () => {
      const t = setup([solo(1), solo(2), solo(3)], {}, { cap: 2 })
      await t.run(['solo-1', 'solo-2', 'solo-3'], { final: finalInsert() })
      const c = await counts()
      expect(c).toMatchObject({ messages: 3, tasks: 1 })
      const units = t.probe.captureUnits()
      expect(units).toHaveLength(3)
      expect(units[2]!.steps).toBeGreaterThan(units[0]!.steps) // only the last unit grew
      expect(units[0]!.steps).toBe(units[1]!.steps)
    })

    it('runs alone as its own unit when the batch yields no chunk (all skipped, or no ids)', async () => {
      const t = setup([S.skipped!])
      const r1 = await t.run(['skipped'], { final: finalInsert('one') })
      expect(r1).toMatchObject({ captured: 0, skipped: { draft: 1 } })
      const r2 = await t.run([], { final: finalInsert('two') })
      expect(r2.captured).toBe(0)
      expect((await e.rows('tasks')).map((r) => r.title)).toEqual(['one', 'two'])
      expect(t.probe.captureUnits()).toHaveLength(0)
    })

    it('is included on every drift retry', async () => {
      const t = setup([S.plain!], { drift: (n) => n <= 2 })
      await t.run(['plain'], { final: finalInsert() })
      const units = t.probe.captureUnits()
      expect(units).toHaveLength(3)
      expect(new Set(units.map((u) => u.steps)).size).toBe(1)
      expect((await e.rows('tasks')).length).toBe(1)
      await e.reset()
      const bare = setup([S.plain!])
      await bare.run(['plain'])
      expect(units[0]!.steps).toBeGreaterThan(bare.probe.captureUnits()[0]!.steps)
    })

    it('an empty final does not change the unit shape', async () => {
      const empty: Program<unknown> = { reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => null }) }
      const a = setup([S.plain!])
      await a.run(['plain'], { final: empty })
      await e.reset()
      const b = setup([S.plain!])
      await b.run(['plain'])
      expect(a.probe.captureUnits()[0]!.steps).toBe(b.probe.captureUnits()[0]!.steps)
    })

    it.each(['capture:existing', 'capture:files', 'resolve:known'])('a read key that collides (%s) throws before anything runs', async (key) => {
      const t = setup([S.withAttachment!])
      const clash: Program<unknown> = { reads: (qc) => ({ [key]: readSet(sql`select 1 as one`.compile(qc.db)) }), build: () => unit({ steps: [], events: [], decode: () => null }) }
      await expect(t.run(['with-attachment'], { final: clash })).rejects.toThrow(/collid/)
      expect(t.objects.writes).toEqual([])
      expect(t.channel.fetches).toEqual([])
      expect(t.probe.log).toEqual([])
      expect(await counts()).toMatchObject({ messages: 0, events: 0 })
    })
  })

  describe('drift', () => {
    it.each([1, 2])('%i drift(s) recover in place, without uploading content again', async (drifts) => {
      const baseline = setup([S.withAttachment!])
      await baseline.run(['with-attachment'])
      const expectedWrites = baseline.objects.writes.length
      await e.reset()
      const t = setup([S.withAttachment!], { drift: (n) => n <= drifts })
      const result = await t.run(['with-attachment'])
      expect(result.captured).toBe(1)
      expect(t.probe.captureUnits()).toHaveLength(drifts + 1)
      expect(t.objects.writes).toHaveLength(expectedWrites)
      expect(t.channel.fetches).toHaveLength(1)
      expect(await counts()).toMatchObject({ messages: 1 })
    })

    it('a third drift propagates UnitDriftError', async () => {
      const t = setup([S.plain!], { drift: () => true })
      await expect(t.run(['plain'])).rejects.toBeInstanceOf(UnitDriftError)
      expect(t.probe.captureUnits()).toHaveLength(3)
    })

    it('CommitOutcomeUnknown is not retried', async () => {
      const t = setup([S.plain!], { unknown: () => true })
      await expect(t.run(['plain'])).rejects.toBeInstanceOf(CommitOutcomeUnknown)
    })

    it('real drift: a concurrent writer captures the same message; the retry sees it, and our duplicate blob is deleted', async () => {
      const t = setup([S.withAttachment!])
      const external = '<with-attachment@fake.test>'
      e.betweenPlanAndCommit(async () => {
        await runCapture(e, { connection_id: C2.id, messages: [captureMessage(e.organizationId, { external_id: external, attachments: [storedAttachment(e.organizationId, 0)] })] })
      })
      const result = await t.run(['with-attachment'])
      expect(result).toMatchObject({ captured: 0, existing: 1 })
      expect(await e.rows('messages')).toHaveLength(1)
      const ours = t.objects.writes.filter((w) => w.key.endsWith('/blob')).map((w) => w.key.replace(/\/blob$/, ''))
      expect(ours).toHaveLength(1)
      expect((await e.rows('files')).map((f) => f.storage_key)).not.toContain(ours[0])
      expect(t.objects.deletes).toContain(`${ours[0]}/blob`)
      expect(await t.objects.get(`${ours[0]}/blob`)).toBeNull()
    })
  })

  describe('duplicate objects', () => {
    const same = (id: string): FakeMessageScript => ({ providerMessageId: id, attachments: [{ name: 'same.bin', bytes: bytesOf(64, 9) }] })

    it('deletes the second copy of identical bytes after the unit', async () => {
      const t = setup([same('d1'), same('d2')])
      const result = await t.run(['d1', 'd2'])
      expect(result).toMatchObject({ captured: 2, orphaned_objects: 0 })
      const files = await e.rows('files')
      expect(files).toHaveLength(2)
      expect(new Set(files.map((f) => f.storage_key)).size).toBe(1)
      const blobs = t.objects.writes.filter((w) => w.key.endsWith('/blob')).map((w) => w.key)
      expect(blobs).toHaveLength(2)
      const kept = `${files[0]!.storage_key}/blob`
      expect(await t.objects.get(kept)).not.toBeNull()
      const dropped = blobs.find((b) => b !== kept)!
      expect(await t.objects.get(dropped)).toBeNull()
    })

    it('a failed delete is counted in orphaned_objects and does not fail the batch', async () => {
      const t = setup([same('d1'), same('d2')])
      t.objects.failDeletes((k) => k.endsWith('/blob'))
      const result = await t.run(['d1', 'd2'])
      expect(result).toMatchObject({ captured: 2, orphaned_objects: 1 })
      expect(await counts()).toMatchObject({ messages: 2 })
    })
  })

  describe('failures and plain data', () => {
    it('an object-store failure rejects the batch and records nothing for the chunk', async () => {
      const t = setup([S.withAttachment!])
      t.objects.failWrites((k) => k.endsWith('/blob'))
      await expect(t.run(['with-attachment'])).rejects.toThrow('object store down')
      expect(await counts()).toMatchObject({ messages: 0, events: 0 })
    })

    it('the result is plain data: it survives structuredClone and holds no ids, addresses or content', async () => {
      const t = setup([S.plain!, S.withAttachment!, S.skipped!, S.nonAscii!, S.failingAttachment!])
      const result = await t.run(['plain', 'with-attachment', 'skipped', 'non-ascii', 'failing-attachment'])
      expect(structuredClone(result)).toEqual(result)
      expect(Object.keys(result).sort()).toEqual(['attachments', 'captured', 'existing', 'orphaned_objects', 'skipped'])
      const text = JSON.stringify(result)
      for (const secret of ['acme.test', 'vault.test', 'fake.test', 'Hello', 'secret-token', 'bücher', e.organizationId]) expect(text).not.toContain(secret)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    })

    it('reads and stores one message at a time, in order', async () => {
      const t = setup([S.plain!, S.parent!, S.withAttachment!])
      await t.run(['plain', 'parent', 'with-attachment'])
      expect(t.channel.reads).toEqual(['plain', 'parent', 'with-attachment'])
    })
  })
}

describe('captureMessages on d1', () => {
  engineSuite()
})
