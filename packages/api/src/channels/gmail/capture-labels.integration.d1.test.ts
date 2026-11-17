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
import { beginScan, captureHistoryPage, captureScanPage, type GmailSyncDeps, type PageResult, type Scan } from './sync.js'

// [[CHN407]] cycle 1: the capture pages read the connection's own capture labels (D1, D2), the scan query follows them (D3, P1, P2), a null settings read
// ends the page inactive (P3). Local D1 over FakeGmail, as `sync.integration.d1.test.ts`.
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
const DAY = 86_400_000
const AFTER = Math.floor((NOW.getTime() - 30 * DAY) / 1000)

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

const mk = (id: string, labels?: string[], internalDate?: number): BuiltGmailMessage =>
  gmailFixture('plain', (s) => ({
    ...s,
    id,
    threadId: `t-${id}`,
    headers: s.headers.map(([k, v]): [string, string] => [k, k === 'Message-ID' ? `<${id}@acme.test>` : v]),
    ...(labels ? { labels } : {}),
    ...(internalDate !== undefined ? { internalDate } : {}),
  }))

/** A D1 that counts the statements that read the connection's label rows: one `captureSettingsRead` is one such statement. */
function countingD1(real: D1Like, seen: string[]): D1Like {
  return {
    prepare(query: string) {
      if (query.includes('connection_capture_labels')) seen.push(query)
      return real.prepare(query)
    },
    batch: (statements: D1PreparedLike[]) => real.batch(statements),
  } as D1Like
}

async function setup(opts: { messages?: BuiltGmailMessage[]; labels?: string[]; synced?: string | null } = {}) {
  const id = await seedGmailConnection(e, {
    key: KEY,
    refreshToken: google.issueRefreshToken(),
    historyId: '1000',
    lastSyncedAt: opts.synced === undefined ? SYNCED : opts.synced,
  })
  if (opts.labels) await setLabels(id, opts.labels)
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
async function setLabels(connectionId: string, labels: string[]): Promise<void> {
  await e.d1!.prepare('delete from connection_capture_labels where connection_id = ?').bind(connectionId).run()
  for (const label_id of labels) await e.insert('connection_capture_labels', { connection_id: connectionId, label_id })
}
const calls = (g: FakeGmail, op: string) => g.calls.filter((c) => c.op === op)
const fetched = (g: FakeGmail) => calls(g, 'full').map((c) => c.messageId)
const queries = (g: FakeGmail) => calls(g, 'list').map((c) => c.q)
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

describe('a history page uses the connection labels (D1, D2)', () => {
  it("['Label_1']: an INBOX-only record is skipped as label with no message read, a Label_1 record is captured, an unlabelled record is judged on the fetched labels", async () => {
    const s = await setup({
      labels: ['Label_1'],
      messages: [mk('h-in', ['INBOX']), mk('h-l1', ['Label_1']), mk('nl-l1', ['Label_1']), mk('nl-in', ['INBOX'])],
    })
    addHistory(s.gmail, '1001', [
      { id: 'h-in', labels: ['INBOX'] },
      { id: 'h-l1', labels: ['Label_1'] },
      { id: 'nl-l1', labels: null },
      { id: 'nl-in', labels: null },
    ])
    s.gmail.profile.historyId = '1002'
    const r = page(await captureHistoryPage(s.deps, s.id))
    expect(r).toMatchObject({ captured: 2, skipped: 2 })
    expect(await captured()).toEqual(['h-l1', 'nl-l1'])
    // h-in was refused on its record's labels, before any read; the unlabelled pair was fetched and judged.
    expect(fetched(s.gmail).sort()).toEqual(['h-l1', 'nl-in', 'nl-l1'])
  })
  it('a connection with no label rows reads INBOX and SENT (the default)', async () => {
    const s = await setup({ messages: [mk('d-in', ['INBOX']), mk('d-l1', ['Label_1'])] })
    await e.d1!.prepare('delete from connection_capture_labels where connection_id = ?').bind(s.id).run()
    addHistory(s.gmail, '1001', [
      { id: 'd-in', labels: ['INBOX'] },
      { id: 'd-l1', labels: ['Label_1'] },
    ])
    s.gmail.profile.historyId = '1002'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 1, skipped: 1 })
    expect(await captured()).toEqual(['d-in'])
  })
})

describe('the scan query follows the labels (D3, P1, P2)', () => {
  const recent = (id: string, labels: string[]) => mk(id, labels, NOW.getTime() - 3600_000)
  it.each([
    [['INBOX', 'SENT'], `after:${AFTER} {in:inbox in:sent}`],
    [['SENT', 'INBOX'], `after:${AFTER} {in:inbox in:sent}`],
    [['INBOX'], `after:${AFTER} {in:inbox}`],
    [['SENT'], `after:${AFTER} {in:sent}`],
    [['INBOX', 'Label_1'], `after:${AFTER}`],
    [['Label_1'], `after:${AFTER}`],
  ])('capture_labels %j queries %s', async (labels, q) => {
    const s = await setup({ labels, synced: null, messages: [recent('q1', ['INBOX'])] })
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    page(await captureScanPage(s.deps, s.id, scan, null))
    expect(queries(s.gmail)).toEqual([q])
  })
  it("['INBOX','Label_1']: a fetched INBOX-only message is captured, a CATEGORY_PROMOTIONS-only one is skipped as label", async () => {
    const s = await setup({
      labels: ['INBOX', 'Label_1'],
      synced: null,
      messages: [recent('s-in', ['INBOX']), recent('s-l1', ['Label_1']), recent('s-promo', ['CATEGORY_PROMOTIONS'])],
    })
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({ captured: 2, skipped: 1 })
    expect(await captured()).toEqual(['s-in', 's-l1'])
  })
  it('the clause is fixed per scan: labels changed between two pages leave the second query equal to the first, while its per-message rule follows the new labels', async () => {
    const msgs = Array.from({ length: 30 }, (_, i) => mk(`f${i}`, ['INBOX'], NOW.getTime() - (i + 1) * 3600_000))
    const s = await setup({ messages: msgs, synced: null })
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({ next_page_token: 'm25', captured: 25 })
    await setLabels(s.id, ['SENT'])
    expect(page(await captureScanPage(s.deps, s.id, scan, 'm25'))).toMatchObject({ captured: 0, skipped: 5 })
    expect(queries(s.gmail)).toEqual([`after:${AFTER} {in:inbox in:sent}`, `after:${AFTER} {in:inbox in:sent}`])
  })
  it('a Scan carried without the field (a Workflow in flight across the deploy) queries the old clause', async () => {
    const s = await setup({ labels: ['Label_1'], synced: null, messages: [recent('old1', ['Label_1'])] })
    const bare: Scan = { kind: 'backfill', after: AFTER, history_id: null }
    page(await captureScanPage(s.deps, s.id, bare, null))
    expect(queries(s.gmail)).toEqual([`after:${AFTER} {in:inbox in:sent}`])
  })
  it('the Scan value is plain data: it survives structuredClone', async () => {
    const s = await setup({ labels: ['INBOX'], synced: null })
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    expect(structuredClone(scan)).toEqual(scan)
  })
})

describe('one settings read per page, and a null read (D1, P3)', () => {
  it('a history page over three messages reads the settings once', async () => {
    const s = await setup({ messages: [mk('r1'), mk('r2'), mk('r3')] })
    addHistory(s.gmail, '1001', [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }])
    s.gmail.profile.historyId = '1002'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 3 })
    expect(s.settingsReads).toHaveLength(1)
  })
  it('a scan page over three messages reads the settings once, and so does the scan start', async () => {
    const s = await setup({
      synced: null,
      messages: [1, 2, 3].map((i) => mk(`p${i}`, ['INBOX'], NOW.getTime() - i * 3600_000)),
    })
    const scan = scanOf(await beginScan(s.deps, s.id, 'backfill'))
    expect(s.settingsReads).toHaveLength(1)
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({ captured: 3 })
    expect(s.settingsReads).toHaveLength(2)
  })
  it('a connection deleted since: history, scan page and scan start are inactive with no Gmail call and no cursor change', async () => {
    const s = await setup({ messages: [mk('n1')] })
    addHistory(s.gmail, '1001', [{ id: 'n1' }])
    const before = JSON.stringify(await e.rows('mail_sync_cursors'))
    await e.d1!.prepare('update channel_connections set deleted_at = ? where id = ?').bind(NOW.toISOString(), s.id).run()
    const scan: Scan = { kind: 'backfill', after: AFTER, history_id: null }
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'inactive' })
    expect(await captureScanPage(s.deps, s.id, scan, null)).toEqual({ outcome: 'inactive' })
    expect(await beginScan(s.deps, s.id, 'backfill')).toEqual({ outcome: 'inactive' })
    expect(s.gmail.calls).toEqual([])
    expect(JSON.stringify(await e.rows('mail_sync_cursors'))).toBe(before)
    expect(await captured()).toEqual([])
  })
})
