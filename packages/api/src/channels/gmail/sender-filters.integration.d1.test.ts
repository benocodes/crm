import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { d1Binding, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import { memoryObjectStore } from '../../objects/store.js'
import { openD1Engine, type Engine } from '../../test/engines.js'
import { FAKE_ENDPOINTS, FakeGoogle } from '../../test/google.js'
import { FakeGmail, type BuiltGmailMessage } from '../../test/gmail.js'
import { gmailFixture } from '../../test/gmail-fixtures.js'
import { seedGmailConnection } from '../../test/gmail-sync.js'
import { recordingObjectStore } from '../../test/objects.js'
import { nodeStreams } from '../../test/streams.js'
import {
  beginScan,
  captureHistoryPage,
  captureScanPage,
  type GmailSyncDeps,
  type PageResult,
  type Scan,
} from './sync.js'

// [[CHN414]] groups 2 (page total), 4 and 5: sender filters ([[CHN407]] D5-D11) applied by history and scan pages, with one settings read per page,
// going forward and per mailbox. Local D1 over FakeGmail, as `capture-labels.integration.d1.test.ts`.
const KEY = new Uint8Array(32).fill(3)
const CONFIG = {
  clientId: 'fake-client-id.apps.test',
  clientSecret: 'fake-client-secret',
  credentialsKey: KEY,
  keyVersion: 1,
  backfillDays: 30,
  attachmentMaxBytes: 50 * 1024 * 1024,
}
const NOW = new Date('2026-11-05T10:00:00.000Z')
const SYNCED = '2026-11-04T10:00:00.000Z'
const MAILBOX = 'owner@vibase.test'

let e: Engine
let google: FakeGoogle
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: CONFIG.clientId, clientSecret: CONFIG.clientSecret })
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
})

/** A message with the given From (and To the mailbox unless given), recent enough for a backfill scan. */
const mk = (id: string, from: string, over: { to?: string; labels?: string[]; age?: number } = {}): BuiltGmailMessage =>
  gmailFixture('plain', (s) => ({
    ...s,
    id,
    threadId: `t-${id}`,
    headers: s.headers.map(([k, v]): [string, string] => [
      k,
      k === 'Message-ID' ? `<${id}@acme.test>` : k === 'From' ? from : k === 'To' ? (over.to ?? MAILBOX) : v,
    ]),
    labels: over.labels ?? ['INBOX'],
    internalDate: NOW.getTime() - (over.age ?? 3600_000),
  }))

function countingD1(real: D1Like, seen: string[]): D1Like {
  return {
    prepare(query: string) {
      if (query.includes('connection_capture_labels')) seen.push(query)
      return real.prepare(query)
    },
    batch: (statements: D1PreparedLike[]) => real.batch(statements),
  } as D1Like
}

async function setup(
  opts: { messages?: BuiltGmailMessage[]; synced?: string | null; mailbox?: string; sub?: string } = {},
) {
  const id = await seedGmailConnection(e, {
    key: KEY,
    refreshToken: google.issueRefreshToken(),
    historyId: '1000',
    lastSyncedAt: opts.synced === undefined ? SYNCED : opts.synced,
    ...(opts.mailbox ? { mailbox: opts.mailbox } : {}),
    ...(opts.sub ? { sub: opts.sub } : {}),
  })
  const gmail = new FakeGmail(opts.messages ?? [], { chunk: 2048 })
  const settingsReads: string[] = []
  const deps: GmailSyncDeps = {
    binding: d1Binding(countingD1(e.d1!, settingsReads), {
      organizationId: e.organizationId,
      authProvider: e.authProvider,
      authOrgId: e.authOrgId,
    }),
    organizationId: e.organizationId,
    objects: recordingObjectStore(memoryObjectStore()),
    streams: nodeStreams(),
    clock: () => NOW,
    newId: () => uuidv7(NOW),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    config: CONFIG,
    endpoints: FAKE_ENDPOINTS,
    fetch: google.fetch,
    clientFor: (accessToken) => gmail.withToken(accessToken, (t) => google.isAccessToken(t)),
  }
  return { id, gmail, deps, settingsReads }
}
const blockOwn = (connection_id: string, kind: 'address' | 'domain', value: string) =>
  e.insert('connection_blocked_senders', { connection_id, kind, value })
const flags = (id: string, over: { group?: boolean; personal?: boolean }) =>
  e
    .d1!.prepare('update connections set exclude_group_addresses = ?, exclude_personal_domains = ? where id = ?')
    .bind(over.group ? 1 : 0, over.personal ? 1 : 0, id)
    .run()
const page = (r: PageResult) => {
  if (r.outcome !== 'page') throw new Error(`expected a page, got ${r.outcome}`)
  return r
}
const scanOf = (s: Awaited<ReturnType<typeof beginScan>>): Scan => {
  if (s.outcome !== 'scan') throw new Error(`expected a scan, got ${s.outcome}`)
  return s.scan
}
const captured = async () =>
  (await e.rows('messages')).map((m) => String(m.external_id).replace('@acme.test', '')).sort()
const addHistory = (g: FakeGmail, id: string, added: Array<{ id: string; labels?: string[] | null }>) =>
  g.history.push({ id, added })
const scanPage = async (s: Awaited<ReturnType<typeof setup>>) => {
  const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
  return page(await captureScanPage(s.deps, s.id, scan, null))
}

describe('both page kinds apply the filter with one settings read (P1)', () => {
  it('a history page skips a blocked counterparty message, captures the rest, and reads the settings once', async () => {
    const s = await setup({ messages: [mk('h-bad', 'a@x.test'), mk('h-ok', 'jane@y.test')] })
    await blockOwn(s.id, 'domain', 'x.test')
    addHistory(s.gmail, '1001', [
      { id: 'h-bad', labels: ['INBOX'] },
      { id: 'h-ok', labels: ['INBOX'] },
    ])
    s.gmail.profile.historyId = '1002'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 1, skipped: 1 })
    expect(await captured()).toEqual(['h-ok'])
    expect(s.settingsReads).toHaveLength(1)
  })

  it('a scan page skips a blocked counterparty message, captures the rest, and reads the settings once', async () => {
    const s = await setup({ synced: null, messages: [mk('s-bad', 'bad@x.test'), mk('s-ok', 'jane@y.test')] })
    await blockOwn(s.id, 'address', 'bad@x.test')
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    s.settingsReads.length = 0
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({ captured: 1, skipped: 1 })
    expect(await captured()).toEqual(['s-ok'])
    expect(s.settingsReads).toHaveLength(1)
  })

  it('a setting changed between two pages applies from the next page', async () => {
    const msgs = Array.from({ length: 30 }, (_, i) => mk(`c${i}`, 'jane@y.test', { age: (i + 1) * 3600_000 }))
    const s = await setup({ messages: msgs, synced: null })
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({
      next_page_token: 'm25',
      captured: 25,
    })
    await blockOwn(s.id, 'domain', 'y.test')
    expect(page(await captureScanPage(s.deps, s.id, scan, 'm25'))).toMatchObject({ captured: 0, skipped: 5 })
    expect(await e.rows('messages')).toHaveLength(25)
  })
})

describe('the page total counts every refusal once (D10)', () => {
  it('label, blocked-and-group, group, personal and a captured message: skipped is their sum', async () => {
    const s = await setup({
      synced: null,
      messages: [
        mk('lab', 'jane@y.test', { labels: ['CATEGORY_PROMOTIONS'] }),
        mk('blk', 'noreply@x.test'),
        mk('grp', 'info@y.test'),
        mk('per', 'friend@gmail.com'),
        mk('ok', 'client@y.test'),
      ],
    })
    s.gmail.extraListed.push('lab')
    await blockOwn(s.id, 'domain', 'x.test')
    await flags(s.id, { group: true, personal: true })
    expect(await scanPage(s)).toMatchObject({ captured: 1, skipped: 4 })
    expect(await captured()).toEqual(['ok'])
  })
})

describe('going forward, per mailbox (D11)', () => {
  it('a captured message stays, with its source and content, after its sender is blocked and a later page runs', async () => {
    const s = await setup({ messages: [mk('g1', 'a@x.test'), mk('g2', 'b@x.test')] })
    addHistory(s.gmail, '1001', [{ id: 'g1', labels: ['INBOX'] }])
    s.gmail.profile.historyId = '1001'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 1 })
    const [kept] = await e.rows('messages')
    await blockOwn(s.id, 'domain', 'x.test')
    addHistory(s.gmail, '1002', [{ id: 'g2', labels: ['INBOX'] }])
    s.gmail.profile.historyId = '1002'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 0, skipped: 1 })
    expect(await captured()).toEqual(['g1'])
    expect(await e.rows('message_sources')).toHaveLength(1)
    expect(await e.rows('messages')).toEqual([kept])
    expect(await s.deps.objects.get(`${kept!.content_key}/v1/body.md`)).not.toBeNull()
  })

  it("a message refused on connection B keeps A's copy and gains no source for B", async () => {
    const shared = mk('both', 'a@x.test')
    const a = await setup({ synced: null, messages: [shared] })
    expect(await scanPage(a)).toMatchObject({ captured: 1 })
    const b = await setup({ synced: null, mailbox: 'second@vibase.test', sub: 'sub-second', messages: [shared] })
    await blockOwn(b.id, 'domain', 'x.test')
    expect(await scanPage(b)).toMatchObject({ captured: 0, skipped: 1 })
    expect(await e.rows('messages')).toHaveLength(1)
    const sources = await e.rows('message_sources')
    expect(sources).toHaveLength(1)
    expect(sources[0]!.connection_id).toBe(a.id)
  })

  it('a message refused on a page and then unblocked is not re-captured by the next history page', async () => {
    const s = await setup({ messages: [mk('r1', 'a@x.test')] })
    await blockOwn(s.id, 'domain', 'x.test')
    addHistory(s.gmail, '1001', [{ id: 'r1', labels: ['INBOX'] }])
    s.gmail.profile.historyId = '1001'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 0, skipped: 1 })
    await e.d1!.prepare('delete from connection_blocked_senders where connection_id = ?').bind(s.id).run()
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 0, skipped: 0 })
    expect(await captured()).toEqual([])
  })
})
