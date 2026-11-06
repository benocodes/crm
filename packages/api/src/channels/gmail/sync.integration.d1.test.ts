import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@vault/storage'
import { openToken } from '../../connections/credentials.js'
import { memoryObjectStore } from '../../objects/store.js'
import { openD1Engine, type Engine } from '../../test/engines.js'
import { FAKE_ENDPOINTS, FakeGoogle } from '../../test/google.js'
import { FakeGmail, type BuiltGmailMessage } from '../../test/gmail.js'
import { gmailFixture } from '../../test/gmail-fixtures.js'
import { runGmailSync, seedGmailConnection } from '../../test/gmail-sync.js'
import { recordingObjectStore } from '../../test/objects.js'
import { nodeStreams } from '../../test/streams.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { wireResponse, type RecordingFixture } from '../../test/recording-replay.js'
import { GmailApiError, HttpGmailClient } from './client.js'
import { beginScan, captureHistoryPage, captureScanPage, type GmailSyncDeps, type PageResult, type Scan, type ScanStart } from './sync.js'

// [[CHN149]] / [[CHN5]] cycle 3: the capture pages (history, backfill, recovery) and the token resolver on local D1, over FakeGmail (wire forms), FakeGoogle's
// token endpoint and a memory object store. Nothing reaches the network: the only `fetch` is FakeGoogle's, and it refuses every other origin.
const KEY = new Uint8Array(32).fill(3)
const CONFIG = { clientId: 'fake-client-id.apps.test', clientSecret: 'fake-client-secret', credentialsKey: KEY, keyVersion: 1, backfillDays: 30, attachmentMaxBytes: 50 * 1024 * 1024 }
const NOW = new Date('2026-11-05T10:00:00.000Z')
const SYNCED = '2026-11-04T10:00:00.000Z'
const DAY = 86_400_000
const unix = (ms: number): number => Math.floor(ms / 1000)

let e: Engine
let google: FakeGoogle
let now: Date
beforeAll(async () => {
  e = await openD1Engine()
  google = await FakeGoogle.create({ clientId: CONFIG.clientId, clientSecret: CONFIG.clientSecret })
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  now = new Date(NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  google.failRefresh(null)
  google.rotateRefreshTokens(false)
})

const mk = (id: string, over: { labels?: string[]; internalDate?: number; from?: string } = {}): BuiltGmailMessage =>
  gmailFixture('plain', (s) => ({
    ...s,
    id,
    threadId: `t-${id}`,
    headers: s.headers.map(([k, v]): [string, string] => [k, k === 'Message-ID' ? `<${id}@acme.test>` : k === 'From' && over.from ? over.from : v]),
    ...(over.labels ? { labels: over.labels } : {}),
    ...(over.internalDate !== undefined ? { internalDate: over.internalDate } : {}),
  }))

interface Setup {
  gmail: FakeGmail
  deps: GmailSyncDeps
  id: string
  refreshToken: string
  objects: ReturnType<typeof recordingObjectStore>
}
async function setup(opts: { messages?: BuiltGmailMessage[]; synced?: string | null; historyId?: string; keyVersion?: number; config?: Partial<GmailSyncDeps['config']>; engine?: Engine; mailbox?: string; sub?: string } = {}): Promise<Setup> {
  const eng = opts.engine ?? e
  const refreshToken = google.issueRefreshToken()
  const id = await seedGmailConnection(eng, {
    key: KEY,
    keyVersion: opts.keyVersion ?? 1,
    refreshToken,
    historyId: opts.historyId ?? '1000',
    lastSyncedAt: opts.synced === undefined ? SYNCED : opts.synced,
    ...(opts.mailbox ? { mailbox: opts.mailbox } : {}),
    ...(opts.sub ? { sub: opts.sub } : {}),
  })
  const gmail = new FakeGmail(opts.messages ?? [], { chunk: 2048 })
  const objects = recordingObjectStore(memoryObjectStore())
  const deps: GmailSyncDeps = {
    binding: eng.binding,
    organizationId: eng.organizationId,
    objects,
    streams: nodeStreams(),
    clock: () => now,
    newId: () => uuidv7(now),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    config: { ...CONFIG, ...(opts.keyVersion ? { keyVersion: opts.keyVersion } : {}), ...opts.config },
    endpoints: FAKE_ENDPOINTS,
    fetch: google.fetch,
    clientFor: (accessToken) => gmail.withToken(accessToken, (t) => google.isAccessToken(t)),
  }
  return { gmail, deps, id, refreshToken, objects }
}
const addHistory = (g: FakeGmail, id: string, added: Array<string | { id: string; labels?: string[] | null }>) =>
  g.history.push({ id, added: added.map((a) => (typeof a === 'string' ? { id: a, labels: ['INBOX'] } : a)) })
const cursor = async () => (await e.rows('mail_sync_cursors'))[0]!
const count = async (t: string) => (await e.rows(t)).length
const eventsOf = async (type: string) => (await e.rows('events')).filter((r) => r.type === type)
const calls = (g: FakeGmail, op: string) => g.calls.filter((c) => c.op === op)
const scanOf = (start: ScanStart): Scan => {
  if (start.outcome !== 'scan') throw new Error(`expected a scan, got ${start.outcome}`)
  return start.scan
}
const page = (r: PageResult) => {
  if (r.outcome !== 'page') throw new Error(`expected a page, got ${r.outcome}`)
  return r
}

describe('history page', () => {
  it('captures INBOX and SENT, skips DRAFT, SPAM, TRASH, CHAT, ignores label-only and delete records, fetches a repeated id once, as the owner', async () => {
    const msgs = [mk('in1'), mk('sent1', { labels: ['SENT'] }), mk('dr', { labels: ['DRAFT', 'INBOX'] }), mk('sp', { labels: ['SPAM'] }), mk('tr', { labels: ['TRASH', 'INBOX'] }), mk('ch', { labels: ['CHAT', 'INBOX'] }), mk('only-label'), mk('gone')]
    const s = await setup({ messages: msgs })
    addHistory(s.gmail, '1001', ['in1'])
    addHistory(s.gmail, '1002', [{ id: 'sent1', labels: ['SENT'] }, { id: 'dr', labels: ['DRAFT', 'INBOX'] }])
    addHistory(s.gmail, '1003', [{ id: 'sp', labels: ['SPAM'] }, { id: 'tr', labels: ['TRASH', 'INBOX'] }, { id: 'ch', labels: ['CHAT', 'INBOX'] }])
    s.gmail.history.push({ id: '1004', labelsAdded: [{ id: 'only-label', labelIds: ['STARRED'] }] })
    s.gmail.history.push({ id: '1005', deleted: ['gone'] })
    addHistory(s.gmail, '1006', ['in1'])
    s.gmail.profile.historyId = '1010'

    const r = page(await captureHistoryPage(s.deps, s.id))
    expect(r).toEqual({ outcome: 'page', next_page_token: null, history_id: '1010', captured: 2, existing: 0, skipped: 4 })
    expect((await e.rows('messages')).map((m) => m.external_id).sort()).toEqual(['in1@acme.test', 'sent1@acme.test'])
    expect(calls(s.gmail, 'full').map((c) => c.messageId).sort()).toEqual(['in1', 'sent1'])
    // The owner is the actor of every row and event.
    for (const t of ['messages', 'threads', 'interactions', 'message_sources']) for (const row of await e.rows(t)) expect(row.created_by, t).toBe(e.userId)
    const events = await e.rows('events')
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((ev) => ev.actor_id === e.userId)).toBe(true)
  })

  it('a record without labelIds is fetched and the label rule runs on the fetched message; a record with labels is still filtered before any fetch', async () => {
    const msgs = [mk('nl-in'), mk('nl-sent', { labels: ['SENT'] }), mk('nl-spam', { labels: ['SPAM', 'INBOX'] }), mk('nl-archived', { labels: ['IMPORTANT'] }), mk('labelled-spam', { labels: ['SPAM'] })]
    const s = await setup({ messages: msgs })
    addHistory(s.gmail, '1001', [{ id: 'nl-in', labels: null }, { id: 'nl-sent', labels: null }, { id: 'nl-spam', labels: null }, { id: 'nl-archived', labels: null }, { id: 'labelled-spam', labels: ['SPAM'] }])
    s.gmail.profile.historyId = '1002'
    const r = page(await captureHistoryPage(s.deps, s.id))
    expect(r).toMatchObject({ captured: 2, skipped: 3 })
    expect((await e.rows('messages')).map((m) => m.external_id).sort()).toEqual(['nl-in@acme.test', 'nl-sent@acme.test'])
    // The unlabelled records were fetched (that is how the rule saw them); the labelled one was not.
    expect(calls(s.gmail, 'full').map((c) => c.messageId).sort()).toEqual(['nl-archived', 'nl-in', 'nl-sent', 'nl-spam'])
  })

  it('a middle page writes page_token and keeps history_id; the last writes the response historyId, clears page_token and sets last_synced_at', async () => {
    const msgs = Array.from({ length: 30 }, (_, i) => mk(`h${i}`))
    const s = await setup({ messages: msgs })
    msgs.forEach((m, i) => addHistory(s.gmail, String(1001 + i), [m.resource.id]))
    s.gmail.profile.historyId = '1031'
    const first = page(await captureHistoryPage(s.deps, s.id))
    expect(first).toMatchObject({ next_page_token: 'h25', history_id: '1000', captured: 25 })
    expect(await cursor()).toMatchObject({ history_id: '1000', page_token: 'h25', last_synced_at: SYNCED })
    now = new Date(NOW.getTime() + 1000)
    // The second call resumes from the stored page token.
    const second = page(await captureHistoryPage(s.deps, s.id))
    expect(second).toMatchObject({ next_page_token: null, history_id: '1031', captured: 5 })
    expect(calls(s.gmail, 'history').map((c) => c.pageToken)).toEqual([null, 'h25'])
    expect(await cursor()).toMatchObject({ history_id: '1031', page_token: null, last_synced_at: now.toISOString() })
    expect(await count('messages')).toBe(30)
  })
})

describe('cursor atomicity', () => {
  it('a last chunk whose unit fails leaves the cursor where it was, and records nothing', async () => {
    const s = await setup({ messages: [mk('c1'), mk('c2')] })
    addHistory(s.gmail, '1001', ['c1', 'c2'])
    s.gmail.profile.historyId = '1005'
    await e.d1!.prepare("create trigger fail_cursor before update on mail_sync_cursors begin select raise(abort, 'cursor refused'); end").run()
    try {
      await expect(captureHistoryPage(s.deps, s.id)).rejects.toThrow()
    } finally {
      await e.d1!.prepare('drop trigger fail_cursor').run()
    }
    expect(await cursor()).toMatchObject({ history_id: '1000', page_token: null, last_synced_at: SYNCED })
    expect(await count('messages')).toBe(0)
    expect(await count('message_sources')).toBe(0)
    // The same page retried commits both together.
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 2, history_id: '1005' })
  })

  it('a page with nothing new still moves the cursor, in its own unit, with no event', async () => {
    const s = await setup()
    s.gmail.profile.historyId = '1005'
    const before = await count('events')
    expect(page(await captureHistoryPage(s.deps, s.id))).toEqual({ outcome: 'page', next_page_token: null, history_id: '1005', captured: 0, existing: 0, skipped: 0 })
    expect(await cursor()).toMatchObject({ history_id: '1005', page_token: null, last_synced_at: now.toISOString() })
    expect(await count('events')).toBe(before)
  })

  it('a page whose messages are all already held also moves the cursor', async () => {
    const s = await setup({ messages: [mk('k1')] })
    addHistory(s.gmail, '1001', ['k1'])
    s.gmail.profile.historyId = '1002'
    await captureHistoryPage(s.deps, s.id)
    await e.d1!.prepare("update mail_sync_cursors set history_id = '1000'").run()
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 0, existing: 1, history_id: '1002' })
    expect(await cursor()).toMatchObject({ history_id: '1002' })
  })
})

describe('source check', () => {
  it('re-running a page fetches no message and emits no event', async () => {
    const s = await setup({ messages: [mk('r1'), mk('r2')] })
    addHistory(s.gmail, '1001', ['r1', 'r2'])
    s.gmail.profile.historyId = '1003'
    await captureHistoryPage(s.deps, s.id)
    const events = await count('events')
    const fetched = s.gmail.calls.length
    await e.d1!.prepare("update mail_sync_cursors set history_id = '1000'").run()
    const again = page(await captureHistoryPage(s.deps, s.id))
    expect(again).toMatchObject({ captured: 0, existing: 2 })
    expect(s.gmail.calls.slice(fetched).filter((c) => c.op !== 'history')).toEqual([])
    expect(await count('events')).toBe(events)
  })

  it('the same mail in two connections is one message and two sources', async () => {
    const m = [mk('shared')]
    const a = await setup({ messages: m })
    const b = await setup({ messages: m, mailbox: 'second@vault.test', sub: 'sub-second' })
    for (const s of [a, b]) {
      addHistory(s.gmail, '1001', ['shared'])
      s.gmail.profile.historyId = '1002'
    }
    expect(page(await captureHistoryPage(a.deps, a.id)).captured).toBe(1)
    expect(page(await captureHistoryPage(b.deps, b.id))).toMatchObject({ captured: 0, existing: 1 })
    expect(await count('messages')).toBe(1)
    expect(await count('message_sources')).toBe(2)
    expect(await eventsOf('message.created')).toHaveLength(1)
    // The second connection did fetch the message once (the source read finds nothing for it), the pipeline's own pre-check then found it existing.
    expect(calls(b.gmail, 'full')).toHaveLength(1)
  })
})

describe('backfill', () => {
  it('scans after:<clock - days> {in:inbox in:sent} with the same query on every page; only the last page writes the cursor; a following history page adds newer mail with no duplicate', async () => {
    const recent = Array.from({ length: 30 }, (_, i) => mk(`b${i}`, { internalDate: NOW.getTime() - (i + 1) * 3600_000 }))
    const old = mk('old', { internalDate: NOW.getTime() - 45 * DAY })
    const s = await setup({ messages: [...recent, old], synced: null })
    s.gmail.extraListed.push('b-hidden')
    s.gmail.add(mk('b-hidden', { labels: ['IMPORTANT'] }))
    const start = await beginScan(s.deps, s.id, 'backfill')
    const after = unix(NOW.getTime() - 30 * DAY)
    expect(start).toEqual({ outcome: 'scan', scan: { kind: 'backfill', after, history_id: null } })
    const first = page(await captureScanPage(s.deps, s.id, scanOf(start), null))
    expect(first).toMatchObject({ next_page_token: 'm25', captured: 25 })
    expect(await cursor()).toMatchObject({ history_id: '1000', page_token: null, last_synced_at: null })
    now = new Date(NOW.getTime() + 5000)
    const last = page(await captureScanPage(s.deps, s.id, scanOf(start), 'm25'))
    expect(last).toMatchObject({ next_page_token: null, history_id: '1000', captured: 5, skipped: 1 })
    expect(calls(s.gmail, 'list').map((c) => c.q)).toEqual([`after:${after} {in:inbox in:sent}`, `after:${after} {in:inbox in:sent}`])
    expect(await cursor()).toMatchObject({ history_id: '1000', page_token: null, last_synced_at: now.toISOString() })
    expect(await count('messages')).toBe(30)
    expect(calls(s.gmail, 'full').map((c) => c.messageId)).not.toContain('old')

    // A history page now captures newer mail, and a re-add of a backfilled message is not captured twice.
    s.gmail.add(mk('newer'))
    addHistory(s.gmail, '1001', ['newer', 'b0'])
    s.gmail.profile.historyId = '1002'
    expect(page(await captureHistoryPage(s.deps, s.id))).toMatchObject({ captured: 1, existing: 1, history_id: '1002' })
    expect(await count('messages')).toBe(31)
  })

  it('an empty mailbox completes and sets last_synced_at', async () => {
    const s = await setup({ synced: null })
    s.gmail.profile.historyId = '1000'
    const run = await runGmailSync(s.deps, s.id)
    expect(run).toMatchObject({ outcome: 'complete', captured: 0, scans: ['backfill'] })
    expect(await cursor()).toMatchObject({ history_id: '1000', page_token: null, last_synced_at: now.toISOString() })
  })

  it('uses GMAIL_BACKFILL_DAYS from the config', async () => {
    const s = await setup({ synced: null, config: { backfillDays: 7 } })
    const start = await beginScan(s.deps, s.id, 'backfill')
    expect(start).toMatchObject({ scan: { after: unix(NOW.getTime() - 7 * DAY) } })
  })

  it('a message fetched without INBOX or SENT is a skip', async () => {
    const s = await setup({ messages: [mk('good', { internalDate: NOW.getTime() - 1000 }), mk('imp', { labels: ['IMPORTANT'], internalDate: NOW.getTime() - 2000 })], synced: null })
    s.gmail.extraListed.push('imp')
    const run = await runGmailSync(s.deps, s.id)
    expect(run).toMatchObject({ outcome: 'complete', captured: 1, skipped: 1 })
    expect((await e.rows('messages')).map((m) => m.external_id)).toEqual(['good@acme.test'])
  })
})

describe('recovery', () => {
  const OLD_SYNC = '2026-11-03T12:00:00.000Z'
  async function expiredSetup(count = 30) {
    const msgs = Array.from({ length: count }, (_, i) => mk(`r${i}`, { internalDate: Date.parse(OLD_SYNC) + (i + 1) * 60_000 }))
    const s = await setup({ messages: msgs, synced: OLD_SYNC })
    s.gmail.expireHistoryBefore = 1500
    s.gmail.profile.historyId = '2000'
    return { s, msgs }
  }

  it('a history 404 returns expired and writes nothing', async () => {
    const { s } = await expiredSetup()
    const before = { events: await count('events'), cursor: await cursor(), messages: await count('messages') }
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'expired' })
    expect(await count('events')).toBe(before.events)
    expect(await count('messages')).toBe(before.messages)
    expect(await cursor()).toEqual(before.cursor)
    expect(s.gmail.accountCalls).toEqual([])
  })

  it('takes a fresh profile history id before its first page, bounds the query by last_synced_at - 1 day, and only the last page writes the id', async () => {
    const { s } = await expiredSetup()
    const start = await beginScan(s.deps, s.id, 'recovery')
    const after = unix(Date.parse(OLD_SYNC) - DAY)
    expect(start).toEqual({ outcome: 'scan', scan: { kind: 'recovery', after, history_id: '2000' } })
    expect(s.gmail.accountCalls).toEqual(['profile'])
    expect(calls(s.gmail, 'list')).toEqual([])
    s.gmail.profile.historyId = '2050'
    const scan = scanOf(start)
    const first = page(await captureScanPage(s.deps, s.id, scan, null))
    expect(first).toMatchObject({ next_page_token: 'm25', history_id: '1000' })
    expect(await cursor()).toMatchObject({ history_id: '1000', last_synced_at: OLD_SYNC })
    now = new Date(NOW.getTime() + 9000)
    const last = page(await captureScanPage(s.deps, s.id, scan, 'm25'))
    expect(last).toMatchObject({ next_page_token: null, history_id: '2000' })
    expect(calls(s.gmail, 'list').every((c) => c.q === `after:${after} {in:inbox in:sent}`)).toBe(true)
    expect(await cursor()).toMatchObject({ history_id: '2000', page_token: null, last_synced_at: now.toISOString() })
  })

  it('a run stopped after the first scan page leaves the old cursor: the next run gets 404 again and finishes with no duplicate', async () => {
    const { s } = await expiredSetup()
    const start = await beginScan(s.deps, s.id, 'recovery')
    await captureScanPage(s.deps, s.id, scanOf(start), null)
    expect(await cursor()).toMatchObject({ history_id: '1000', last_synced_at: OLD_SYNC })
    expect(await count('messages')).toBe(25)
    // The next run: history says 404 again.
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'expired' })
    const run = await runGmailSync(s.deps, s.id)
    expect(run).toMatchObject({ outcome: 'complete', scans: ['recovery'], captured: 5 })
    expect(await count('messages')).toBe(30)
    expect(await eventsOf('message.created')).toHaveLength(30)
    expect(await cursor()).toMatchObject({ history_id: '2000', page_token: null })
  })

  it('without a last_synced_at the recovery scan falls back to the backfill window', async () => {
    const s = await setup({ synced: null })
    s.gmail.profile.historyId = '2000'
    expect(await beginScan(s.deps, s.id, 'recovery')).toMatchObject({ scan: { after: unix(NOW.getTime() - 30 * DAY), history_id: '2000' } })
  })
})

describe('token resolver and refresh', () => {
  it('POSTs the refresh token, client id and secret to the injected endpoint, once per page however many messages', async () => {
    const s = await setup({ messages: [mk('t1'), mk('t2'), mk('t3')] })
    addHistory(s.gmail, '1001', ['t1', 't2', 't3'])
    s.gmail.profile.historyId = '1002'
    await captureHistoryPage(s.deps, s.id)
    expect(google.refreshRequests.filter((r) => r.refresh_token === s.refreshToken)).toEqual([{ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: CONFIG.clientId, client_secret: CONFIG.clientSecret }])
    expect(calls(s.gmail, 'full')).toHaveLength(3)
    // A second page refreshes again: the access token lives for one page only.
    await e.d1!.prepare("update mail_sync_cursors set history_id = '1000'").run()
    await captureHistoryPage(s.deps, s.id)
    expect(google.refreshRequests.filter((r) => r.refresh_token === s.refreshToken)).toHaveLength(2)
  })

  it('a refresh response with a new refresh token inserts a row sealed under the configured key and version and deletes the older rows', async () => {
    const s = await setup({ keyVersion: 7 })
    const [old] = await e.rows('channel_credentials')
    google.rotateRefreshTokens(true)
    await captureHistoryPage(s.deps, s.id)
    const rows = await e.rows('channel_credentials')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).not.toBe(old!.id)
    expect(rows[0]).toMatchObject({ connection_id: s.id, key_version: 7, created_by: e.userId })
    const opened = await openToken(KEY, rows[0]!.refresh_token_ciphertext as string)
    expect(opened).toMatch(/^rt-/)
    expect(opened).not.toBe(s.refreshToken)
    expect(rows[0]!.refresh_token_ciphertext).not.toContain(opened)
    // The next page uses the new refresh token.
    await captureHistoryPage(s.deps, s.id)
    expect(google.refreshRequests.at(-1)!.refresh_token).toBe(opened)
  })

  it('a response without a refresh token changes nothing', async () => {
    const s = await setup()
    const before = await e.rows('channel_credentials')
    await captureHistoryPage(s.deps, s.id)
    expect(await e.rows('channel_credentials')).toEqual(before)
  })

  it('a credential under another key version throws credential_key_mismatch: not reauth, no Google call', async () => {
    const s = await setup({ config: { keyVersion: 2 } })
    const requests = google.refreshRequests.length
    await expect(captureHistoryPage(s.deps, s.id)).rejects.toThrow(/credential_key_mismatch/)
    expect((await e.rows('channel_connections'))[0]!.status).toBe('active')
    expect(google.refreshRequests.length).toBe(requests)
  })
})

describe('invalid_grant and other refresh failures', () => {
  it('invalid_grant: reauth_required, last_error_code, one connection.updated by the owner, no Gmail call; a second page is inactive with no second event', async () => {
    const s = await setup({ messages: [mk('x1')] })
    addHistory(s.gmail, '1001', ['x1'])
    google.revoke(s.refreshToken)
    const requests = google.refreshRequests.length
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'reauth' })
    const conn = (await e.rows('channel_connections'))[0]!
    expect(conn.status).toBe('reauth_required')
    expect(await e.rows('mail_sync_state')).toEqual([expect.objectContaining({ connection_id: s.id, last_error_code: 'invalid_grant', last_error_at: now.toISOString() })])
    const updated = await eventsOf('connection.updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ actor_id: e.userId, resource_id: s.id })
    expect(s.gmail.calls).toEqual([])
    expect(await count('messages')).toBe(0)
    // Second page.
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'inactive' })
    expect(await eventsOf('connection.updated')).toHaveLength(1)
    expect(google.refreshRequests.length).toBe(requests + 1)
  })

  it('invalid_grant on a scan page is the reauth outcome; a backfill start makes no Google call', async () => {
    const s = await setup({ synced: null })
    google.revoke(s.refreshToken)
    expect(await beginScan(s.deps, s.id, 'backfill')).toEqual({ outcome: 'scan', scan: expect.anything() })
    // beginScan(backfill) makes no Google call; the first page meets the revoked grant.
    const scan = { kind: 'backfill' as const, after: 1, history_id: null }
    expect(await captureScanPage(s.deps, s.id, scan, null)).toEqual({ outcome: 'reauth' })
    expect((await e.rows('channel_connections'))[0]!.status).toBe('reauth_required')
  })

  it.each([
    ['invalid_client', 'invalid_client' as const, 'oauth_error'],
    ['a 5xx', 503, 'token_endpoint'],
    ['a network error', 'network' as const, 'token_endpoint'],
  ])('%s changes nothing and throws', async (_name, mode, code) => {
    const s = await setup()
    google.failRefresh(mode)
    const before = { conn: await e.rows('channel_connections'), events: await count('events'), state: await e.rows('mail_sync_state') }
    const requests = google.refreshRequests.length
    await expect(captureHistoryPage(s.deps, s.id)).rejects.toMatchObject({ name: 'GoogleRefreshError', code })
    expect(google.refreshRequests.length).toBe(requests + 1)
    expect(await e.rows('channel_connections')).toEqual(before.conn)
    expect(await e.rows('mail_sync_state')).toEqual(before.state)
    expect(await count('events')).toBe(before.events)
    expect(s.gmail.calls).toEqual([])
  })
})

describe('inactive connections', () => {
  it.each([
    ['reauth_required', { status: 'reauth_required' }],
    ['suspended', { status: 'suspended' }],
    ['soft-deleted', { deleted_at: '2026-11-04T00:00:00.000Z' }],
  ])('%s: inactive with no Google call and no write', async (_name, patch) => {
    const s = await setup({ messages: [mk('i1')], synced: null })
    addHistory(s.gmail, '1001', ['i1'])
    await e.update('channel_connections', s.id, patch)
    const snapshot = async () => ({ events: await count('events'), cursor: await cursor(), conn: await e.rows('channel_connections'), state: await e.rows('mail_sync_state'), creds: await e.rows('channel_credentials'), messages: await count('messages') })
    const before = await snapshot()
    const requests = google.refreshRequests.length
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'inactive' })
    expect(await beginScan(s.deps, s.id, 'backfill')).toEqual({ outcome: 'inactive' })
    expect(await beginScan(s.deps, s.id, 'recovery')).toEqual({ outcome: 'inactive' })
    expect(await captureScanPage(s.deps, s.id, { kind: 'backfill', after: 1, history_id: null }, null)).toEqual({ outcome: 'inactive' })
    expect(await snapshot()).toEqual(before)
    expect(s.gmail.calls).toEqual([])
    expect(s.gmail.accountCalls).toEqual([])
    expect(google.refreshRequests.length).toBe(requests)
  })

  it('an unknown connection id is inactive', async () => {
    const s = await setup()
    expect(await captureHistoryPage(s.deps, uuidv7(now))).toEqual({ outcome: 'inactive' })
  })
})

describe('throttle', () => {
  const err = (status: number, reason: string | null = null, retryAfterSeconds: number | null = null) => new GmailApiError({ status, reason, retryAfterSeconds })

  it.each([
    ['429 with Retry-After', err(429, null, 12), 12],
    ['429 without Retry-After', err(429), null],
    ['403 rateLimitExceeded', err(403, 'rateLimitExceeded'), null],
    ['403 userRateLimitExceeded with Retry-After', err(403, 'userRateLimitExceeded', 7), 7],
  ])('%s on a history list is throttled', async (_name, error, seconds) => {
    const s = await setup()
    s.gmail.failWhen((c) => c.op === 'history', error)
    expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'throttled', retry_after_seconds: seconds })
    expect(await cursor()).toMatchObject({ history_id: '1000', last_synced_at: SYNCED })
  })

  it('throttles on a scan list and on a message get', async () => {
    const s = await setup({ messages: [mk('th1')], synced: null })
    s.gmail.failWhen((c) => c.op === 'list', err(429, null, 3))
    expect(await captureScanPage(s.deps, s.id, { kind: 'backfill', after: 1, history_id: null }, null)).toEqual({ outcome: 'throttled', retry_after_seconds: 3 })
    const g = await setup({ messages: [mk('th2')] })
    addHistory(g.gmail, '1001', ['th2'])
    g.gmail.failWhen((c) => c.op === 'full', err(429, null, 4))
    expect(await captureHistoryPage(g.deps, g.id)).toEqual({ outcome: 'throttled', retry_after_seconds: 4 })
    expect(await count('messages')).toBe(0)
  })

  it('another 403 throws', async () => {
    const s = await setup()
    s.gmail.failWhen((c) => c.op === 'history', err(403, 'forbidden'))
    await expect(captureHistoryPage(s.deps, s.id)).rejects.toBeInstanceOf(GmailApiError)
  })

  it('a 401 mid-page throws (the retry refreshes again)', async () => {
    const s = await setup()
    s.gmail.failWhen((c) => c.op === 'history', err(401))
    await expect(captureHistoryPage(s.deps, s.id)).rejects.toBeInstanceOf(GmailApiError)
  })

  it('a throttle after chunk 1 committed: the retried page captures the rest with no duplicates', async () => {
    const small = await openD1Engine({ maxSetSize: 4 })
    try {
      await small.reset()
      const msgs = Array.from({ length: 6 }, (_, i) => mk(`q${i}`))
      const s = await setup({ messages: msgs, engine: small })
      msgs.forEach((m, i) => addHistory(s.gmail, String(1001 + i), [m.resource.id]))
      s.gmail.profile.historyId = '1010'
      s.gmail.failWhen((c) => c.op === 'raw' && c.messageId === 'q5', err(429, null, 9))
      expect(await captureHistoryPage(s.deps, s.id)).toEqual({ outcome: 'throttled', retry_after_seconds: 9 })
      const held = (await small.rows('messages')).length
      expect(held).toBeGreaterThan(0)
      expect(held).toBeLessThan(6)
      expect((await small.rows('mail_sync_cursors'))[0]).toMatchObject({ history_id: '1000' })
      s.gmail.clearFailures()
      const again = page(await captureHistoryPage(s.deps, s.id))
      expect(again).toMatchObject({ captured: 6 - held, existing: held, history_id: '1010' })
      expect(await small.rows('messages')).toHaveLength(6)
      expect((await small.rows('events')).filter((r) => r.type === 'message.created')).toHaveLength(6)
    } finally {
      await small.close()
    }
  })
})

describe('secrecy and step returns', () => {
  it('every page result survives structuredClone and holds only counts, page tokens, history ids and outcomes', async () => {
    const s = await setup({ messages: [mk('s1')], synced: null })
    addHistory(s.gmail, '1001', ['s1'])
    s.gmail.profile.historyId = '1002'
    const allowed = new Set(['outcome', 'next_page_token', 'history_id', 'captured', 'existing', 'skipped', 'retry_after_seconds', 'scan', 'kind', 'after'])
    const results: unknown[] = []
    const start = await beginScan(s.deps, s.id, 'backfill')
    results.push(start, await captureScanPage(s.deps, s.id, scanOf(start), null), await captureHistoryPage(s.deps, s.id), await captureHistoryPage(s.deps, uuidv7(now)))
    s.gmail.expireHistoryBefore = 5000
    results.push(await captureHistoryPage(s.deps, s.id))
    for (const r of results) {
      expect(structuredClone(r)).toEqual(r)
      const walk = (v: unknown): void => {
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (expect(allowed.has(k), `key ${k}`).toBe(true), walk(x))
      }
      walk(r)
    }
  })

  it('no access or refresh token appears in a row, a result, a log line or an error message', async () => {
    const logs: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')))
    const s = await setup({ messages: [mk('z1')] })
    addHistory(s.gmail, '1001', ['z1'])
    google.rotateRefreshTokens(true)
    const outputs: string[] = []
    outputs.push(JSON.stringify(await captureHistoryPage(s.deps, s.id)))
    const errors: string[] = []
    for (const mode of ['invalid_client', 503, 'network'] as const) {
      google.failRefresh(mode)
      await captureHistoryPage(s.deps, s.id).catch((err: Error) => errors.push(`${err.name} ${err.message} ${err.stack ?? ''}`))
    }
    google.failRefresh(null)
    for (const rt of google.refreshTokens) google.revoke(rt)
    outputs.push(JSON.stringify(await captureHistoryPage(s.deps, s.id)))
    expect(errors).toHaveLength(3)
    const secrets = [...google.refreshTokens, ...google.accessTokens, CONFIG.clientSecret]
    expect(secrets.length).toBeGreaterThan(3)
    const tables = ['messages', 'threads', 'interactions', 'message_sources', 'events', 'channel_connections', 'mail_sync_state', 'mail_sync_cursors', 'identities', 'files', 'attachments']
    const rows = JSON.stringify(await Promise.all(tables.map((t) => e.rows(t).catch(() => []))))
    const creds = JSON.stringify(await e.rows('channel_credentials'))
    for (const secret of secrets) {
      for (const [where, text] of Object.entries({ rows, creds, results: outputs.join('\n'), logs: logs.join('\n'), errors: errors.join('\n') })) expect(text.includes(secret), `${where} holds a secret`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [[CHN5]] D70, D82, D83 ([[CHN153b]]): the recorded `hq` pages served to the real client and the page service.
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/google/', import.meta.url))
const recorded = (name: string): RecordingFixture => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as RecordingFixture
/** A client over HTTP: the fake serves every request, except those `override` answers (a fresh Response per call, so a body is never read twice). */
const viaHttp = (gmail: FakeGmail, override: (url: URL) => Response | null) => (accessToken: () => Promise<string>) =>
  new HttpGmailClient({
    accessToken,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return override(url) ?? gmail.handle(new Request(url, init), (t) => google.isAccessToken(t))
    }) as typeof fetch,
  })

describe('the recorded history page (D70, D82)', () => {
  it('INBOX and SENT records are fetched; DRAFT and SPAM records are skipped with no fetch, counted as label', async () => {
    const rec = recorded('recorded-history-list-200')
    const records = (rec.recording.response.body as { history: Array<{ messagesAdded: Array<{ message: { id: string; threadId: string; labelIds: string[] } }> }> }).history
    const messages = records.map((r) => r.messagesAdded[0]!.message)
    const s = await setup({ messages: messages.map((m) => mk(m.id, { labels: m.labelIds })) })
    s.deps.clientFor = viaHttp(s.gmail, (url) => (url.pathname.endsWith('/history') ? wireResponse(rec.recording) : null))
    const r = page(await captureHistoryPage(s.deps, s.id))
    const fetched = messages.filter((m) => m.labelIds.includes('INBOX') || m.labelIds.includes('SENT')).map((m) => m.id).sort()
    expect(fetched).toHaveLength(8)
    expect(calls(s.gmail, 'full').map((c) => c.messageId).sort()).toEqual(fetched)
    expect(calls(s.gmail, 'raw').map((c) => c.messageId).sort()).toEqual(fetched)
    expect(r).toMatchObject({ outcome: 'page', next_page_token: null, captured: 8, existing: 0, skipped: 12 })
    expect(await count('messages')).toBe(8)
  })
})

describe('a quota 403 is a throttle on every call kind the page makes (D83)', () => {
  const quota = (): Response => wireResponse(recorded('recorded-messages-list-403').recording)
  const scan: Scan = { kind: 'backfill', after: 1, history_id: null }
  const throttled = { outcome: 'throttled', retry_after_seconds: null }

  it('the recorded 403 has no Retry-After and the rate reason', () => {
    const res = quota()
    expect(res.status).toBe(403)
    expect(res.headers.get('retry-after')).toBeNull()
  })

  it.each([
    ['a scan list', (url: URL) => url.pathname.endsWith('/messages')],
    ['a message get (format=full)', (url: URL) => /\/messages\/[^/]+$/.test(url.pathname) && url.searchParams.get('format') === 'full'],
    ['a message get (format=raw)', (url: URL) => /\/messages\/[^/]+$/.test(url.pathname) && url.searchParams.get('format') === 'raw'],
    ['an attachment get', (url: URL) => url.pathname.includes('/attachments/')],
  ])('%s', async (_name, hit) => {
    const s = await setup({ messages: [gmailFixture('attachment', (m) => ({ ...m, id: 'qa' }))], synced: null })
    s.deps.clientFor = viaHttp(s.gmail, (url) => (hit(url) ? quota() : null))
    expect(await captureScanPage(s.deps, s.id, scan, null)).toEqual(throttled)
    expect(await count('messages')).toBe(0)
    expect((await e.rows('message_attachments')).filter((a) => a.fetch_status === 'failed')).toEqual([])
  })

  it('a history list too', async () => {
    const s = await setup()
    s.deps.clientFor = viaHttp(s.gmail, (url) => (url.pathname.endsWith('/history') ? quota() : null))
    expect(await captureHistoryPage(s.deps, s.id)).toEqual(throttled)
  })

  it('an attachment throttle leaves no failed link; the retry captures the message with its attachment stored', async () => {
    const s = await setup({ messages: [gmailFixture('attachment', (m) => ({ ...m, id: 'qa' }))], synced: null })
    let hits = 1
    s.deps.clientFor = viaHttp(s.gmail, (url) => (url.pathname.includes('/attachments/') && hits-- > 0 ? quota() : null))
    expect(await captureScanPage(s.deps, s.id, scan, null)).toEqual(throttled)
    expect(await count('message_attachments')).toBe(0)
    const again = page(await captureScanPage(s.deps, s.id, scan, null))
    expect(again).toMatchObject({ captured: 1 })
    const rows = await e.rows('message_attachments')
    expect(rows.map((a) => [a.fetch_status, a.fetch_error])).toEqual([['stored', null]])
    expect(calls(s.gmail, 'attachment')).toHaveLength(2)
  })

  it('a 429 on an attachment is a throttle too, and its Retry-After is carried', async () => {
    const s = await setup({ messages: [gmailFixture('attachment', (m) => ({ ...m, id: 'qa' }))], synced: null })
    s.gmail.failWhen((c) => c.op === 'attachment', new GmailApiError({ status: 429, gmailStatus: 'RESOURCE_EXHAUSTED', retryAfter: '11', retryAfterSeconds: 11 }))
    expect(await captureScanPage(s.deps, s.id, scan, null)).toEqual({ outcome: 'throttled', retry_after_seconds: 11 })
    expect(await count('messages')).toBe(0)
  })

  it('a 403 that is not a rate reason on an attachment stays access_denied (stored as a failed link; the message is captured)', async () => {
    const s = await setup({ messages: [gmailFixture('attachment', (m) => ({ ...m, id: 'qa' }))], synced: null })
    s.gmail.failWhen((c) => c.op === 'attachment', new GmailApiError({ status: 403, gmailStatus: 'PERMISSION_DENIED', reason: 'forbidden' }))
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({ captured: 1 })
    expect((await e.rows('message_attachments')).map((a) => [a.fetch_status, a.fetch_error])).toEqual([['failed', 'access_denied']])
  })

  it('a 404 and a 5xx on an attachment keep their codes', async () => {
    const s = await setup({ messages: [gmailFixture('attachment', (m) => ({ ...m, id: 'qa' }))], synced: null })
    s.gmail.failWhen((c) => c.op === 'attachment', new GmailApiError({ status: 503 }))
    expect(page(await captureScanPage(s.deps, s.id, scan, null))).toMatchObject({ captured: 1 })
    expect((await e.rows('message_attachments')).map((a) => [a.fetch_status, a.fetch_error])).toEqual([['failed', 'http_503']])
  })
})

