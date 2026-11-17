import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { captureFilter, type CaptureFilterSettings } from '../connections/capture-filter.js'
import { memoryObjectStore } from '../objects/store.js'
import { bytesOf, FakeChannel, type FakeMessageScript } from '../test/channels.js'
import { ensureConnection } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { recordingObjectStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import { captureMessages, type ExcludeHook, type PipelineContext } from './pipeline.js'

// [[CHN414]] groups 2 (pipeline half) and 3: the exclude hook ([[CHN407]] D5) through the real pipeline on D1 with FakeChannel.
const NOW = '2026-10-22T10:00:00.000Z'
const C1 = { id: '0190b2c4-0000-7000-8000-0000000000c1' }
const MAILBOX = 'owner@acme.test'
const TABLES = [
  'messages',
  'message_sources',
  'interactions',
  'interaction_participants',
  'files',
  'message_attachments',
  'threads',
  'events',
] as const

let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  await ensureConnection(e.binding, e, C1.id)
})

function setup(scripts: FakeMessageScript[]) {
  const channel = new FakeChannel(scripts)
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
  }
  const run = (ids: string[], exclude?: ExcludeHook) =>
    captureMessages(ctx, channel, C1, ids, exclude ? { exclude } : {})
  return { channel, objects, run }
}
const counts = async () =>
  Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await e.rows(t)).length] as const)))
const settings = (over: Partial<CaptureFilterSettings> = {}): CaptureFilterSettings => ({
  blocked_addresses: [],
  blocked_domains: [],
  exclude_group_addresses: false,
  exclude_personal_domains: false,
  ...over,
})
const msg = (id: string, from: string, over: Partial<FakeMessageScript> = {}): FakeMessageScript => ({
  providerMessageId: id,
  from,
  to: [MAILBOX],
  ...over,
})

describe('the exclude hook stores nothing (D5)', () => {
  it('an excluded message opens no raw body, fetches no attachment, writes no row, source, participant, object or event; a captured one beside it is stored', async () => {
    const attachment = [{ name: 'a.pdf', mimeType: 'application/pdf', bytes: bytesOf(300) }]
    const t = setup([
      msg('bad', 'bad@x.test', { attachments: attachment }),
      msg('good', 'jane@y.test', { attachments: attachment }),
    ])
    // Baseline: what a message alone adds.
    const before = await counts()
    const r = await t.run(['bad', 'good'], captureFilter(settings({ blocked_domains: ['x.test'] }), MAILBOX))
    expect(r).toMatchObject({ captured: 1, existing: 0, skipped: { blocked: 1 } })
    expect(t.channel.opens).toEqual(['good'])
    expect(t.channel.fetches).toHaveLength(1)
    const after = await counts()
    expect(after.messages).toBe(before.messages! + 1)
    expect(after.message_sources).toBe(before.message_sources! + 1)
    const externalIds = (await e.rows('messages')).map((m) => m.external_id)
    expect(externalIds).toEqual(['<good@fake.test>'])
    expect((await e.rows('events')).filter((x) => x.type === 'message.created')).toHaveLength(1)
    // No object was written for the excluded message (content keys are by external id).
    expect(t.objects.writes.every((w) => !w.key.includes('bad@fake.test'))).toBe(true)
  })

  it('an only-excluded batch leaves every table unchanged and writes no object', async () => {
    const t = setup([msg('bad', 'bad@x.test', { attachments: [{ name: 'a.pdf', bytes: bytesOf(50) }] })])
    const before = await counts()
    const r = await t.run(['bad'], captureFilter(settings({ blocked_addresses: ['bad@x.test'] }), MAILBOX))
    expect(r).toEqual({
      captured: 0,
      existing: 0,
      skipped: { blocked: 1 },
      attachments: { stored: 0, failed: 0, skipped: 0 },
      orphaned_objects: 0,
    })
    expect(await counts()).toEqual(before)
    expect(t.objects.writes).toEqual([])
    expect(t.channel.opens).toEqual([])
    expect(t.channel.fetches).toEqual([])
  })

  it('a call with no hook captures the same messages as before', async () => {
    const t = setup([msg('bad', 'bad@x.test'), msg('good', 'jane@y.test')])
    const r = await t.run(['bad', 'good'])
    expect(r).toMatchObject({ captured: 2, skipped: {} })
    expect((await e.rows('messages')).length).toBe(2)
  })

  it("a message the hook excludes still counts normalisation's dropped addresses", async () => {
    const t = setup([
      msg('bad', 'bad@x.test', {
        participants: [
          { kind: 'email', value: 'bad@x.test', role: 'from' },
          { kind: 'email', value: 'not an address', role: 'to' },
        ],
      }),
    ])
    const r = await t.run(['bad'], captureFilter(settings({ blocked_domains: ['x.test'] }), MAILBOX))
    expect(r.skipped).toEqual({ dropped_address: 1, blocked: 1 })
  })
})

describe('precedence and counting through the pipeline (D10)', () => {
  it('each message counts once under its first refusal, in the skipped record', async () => {
    const t = setup([
      msg('lab', 'jane@y.test', { skip: 'label' }),
      msg('blk', 'noreply@x.test'), // blocked and a group address
      msg('grp', 'info@y.test'),
      msg('per', 'friend@gmail.com'),
      msg('ok', 'client@y.test'),
    ])
    const r = await t.run(
      ['lab', 'blk', 'grp', 'per', 'ok'],
      captureFilter(
        settings({ blocked_domains: ['x.test'], exclude_group_addresses: true, exclude_personal_domains: true }),
        MAILBOX,
      ),
    )
    expect(r.captured).toBe(1)
    expect(r.skipped).toEqual({ label: 1, blocked: 1, group_address: 1, personal_domain: 1 })
    expect(Object.values(r.skipped).reduce((a, b) => a + b, 0)).toBe(4)
  })
})

describe('a mixed-case, tagged sender through the pipeline (D8, D9)', () => {
  it('Support+EU@Y.test is normalised, then skipped as group_address with the flag on and captured with it off', async () => {
    const on = setup([msg('mixed', 'Support+EU@Y.test')])
    expect(
      (await on.run(['mixed'], captureFilter(settings({ exclude_group_addresses: true }), MAILBOX))).skipped,
    ).toEqual({ group_address: 1 })
    expect(await e.rows('messages')).toHaveLength(0)
    const off = setup([msg('mixed', 'Support+EU@Y.test')])
    expect(await off.run(['mixed'], captureFilter(settings(), MAILBOX))).toMatchObject({ captured: 1, skipped: {} })
  })
})
