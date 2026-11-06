import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { expandBody, type RecordingFixture } from '../../test/recording-replay.js'
import { FAKE_ENDPOINTS, FakeGoogle } from '../../test/google.js'
import { FakeGmail, attachmentWire, buildGmailMessage, rawWire, type BuiltGmailMessage } from '../../test/gmail.js'
import { gmailFixture } from '../../test/gmail-fixtures.js'
import { GmailApiError } from './client.js'

// [[CHN5]] D72, D82, D86 ([[CHN153b]]): the fake matches reality. For each recorded kind, what `FakeGmail` (and `FakeGoogle` for the token endpoint) answers to the
// equivalent call has the same key-path set as the recorded response, apart from members listed in OPTIONAL with a reason. Array indexes are collapsed.
const DIR = fileURLToPath(new URL('../../test/fixtures/google/', import.meta.url))
const recorded = (name: string): RecordingFixture => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8')) as RecordingFixture

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
function pathsOf(v: Json, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((e) => pathsOf(e, `${at}[]`))
  if (v !== null && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => pathsOf(x, `${at}.${k}`))
  return [at]
}
const keyPaths = (v: unknown): string[] => [...new Set(pathsOf(v as Json))].sort()
const recordedPaths = (name: string): string[] => keyPaths(expandBody(recorded(name).recording.response.body as Json))

/** Members a recorded response has and the fake need not, or the reverse, each with its reason. Empty today: the fake serves every observed member. */
const OPTIONAL: Record<string, { recordedOnly?: string[]; fakeOnly?: string[] }> = {}
const same = (name: string, got: unknown): void => {
  const opt = OPTIONAL[name] ?? {}
  const want = recordedPaths(name).filter((p) => !(opt.recordedOnly ?? []).includes(p))
  const have = keyPaths(got).filter((p) => !(opt.fakeOnly ?? []).includes(p))
  expect({ missing: want.filter((p) => !have.includes(p)), extra: have.filter((p) => !want.includes(p)) }, name).toEqual({ missing: [], extra: [] })
}

const G = 'https://gmail.googleapis.com/gmail/v1/users/me'
const valid = (t: string): boolean => t === 'tok'
const call = async (g: FakeGmail, path: string): Promise<{ res: Response; body: unknown }> => {
  const res = await g.handle(new Request(`${G}${path}`, { headers: { authorization: 'Bearer tok' } }), valid)
  return { res, body: JSON.parse(await res.text()) }
}

const alternative = (id: string, labels: string[]): BuiltGmailMessage =>
  buildGmailMessage({
    id,
    labels,
    headers: [['From', 'A <a@x.test>'], ['To', 'b@x.test'], ['Subject', 's'], ['Message-ID', `<${id}@x.test>`]],
    payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', text: 'plain text' }, { mimeType: 'text/html', text: '<p>html</p>' }] },
  })

describe('the fake matches the recorded shapes (key-path sets)', () => {
  it('messages list 200: ids, threadIds, nextPageToken and resultSizeEstimate', async () => {
    const g = new FakeGmail(Array.from({ length: 30 }, (_, i) => alternative(`l${i}`, ['INBOX'])))
    same('recorded-messages-list-200', (await call(g, '/messages?q=after%3A1+%7Bin%3Ainbox+in%3Asent%7D&maxResults=25')).body)
  })
  it('history list 200: every messagesAdded record carries labelIds and a sibling messages array', async () => {
    const g = new FakeGmail([alternative('h1', ['INBOX']), alternative('h2', ['SENT'])])
    g.history.push({ id: '2001', added: [{ id: 'h1' }] }, { id: '2002', added: [{ id: 'h2' }] })
    const { body } = await call(g, '/history?startHistoryId=1000&maxResults=25&historyTypes=messageAdded')
    same('recorded-history-list-200', body)
    expect((body as { history: Array<{ messagesAdded: Array<{ message: { labelIds: string[] } }> }> }).history.map((r) => r.messagesAdded[0]!.message.labelIds)).toEqual([['INBOX'], ['SENT']])
  })
  it('a history record is labelless only on request (`labels: null`), the D73 fallback form', async () => {
    const g = new FakeGmail([alternative('n1', ['INBOX'])])
    g.history.push({ id: '2001', added: [{ id: 'n1', labels: null }] })
    const { body } = await call(g, '/history?startHistoryId=1000&maxResults=25')
    expect(JSON.stringify(body)).not.toContain('labelIds')
  })
  it('message full 200 (inbox and sent forms)', async () => {
    const g = new FakeGmail([alternative('f1', ['UNREAD', 'CATEGORY_UPDATES', 'INBOX']), alternative('f2', ['SENT'])])
    same('recorded-message-full-inbox-200', (await call(g, '/messages/f1?format=full')).body)
    same('recorded-message-full-sent-200', (await call(g, '/messages/f2?format=full')).body)
  })
  it('message raw 200: snippet, sizeEstimate, historyId, internalDate and labelIds beside raw', async () => {
    const g = new FakeGmail([alternative('r1', ['INBOX'])])
    same('recorded-message-raw-200', (await call(g, '/messages/r1?format=raw')).body)
  })
  it('attachment get 200: size and data', async () => {
    const g = new FakeGmail([gmailFixture('attachment')])
    same('recorded-attachment-get-200', (await call(g, '/messages/with-attachment/attachments/att-pdf')).body)
  })
  it('token refresh 200: scope, expires_in, token_type and an id_token, and no refresh_token', async () => {
    const google = await FakeGoogle.create()
    const rt = google.issueRefreshToken()
    const res = await google.fetch(FAKE_ENDPOINTS.tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: google.clientId, client_secret: google.clientSecret }).toString() })
    const body = (await res.json()) as Record<string, unknown>
    same('recorded-token-refresh-200', body)
    expect(body).not.toHaveProperty('refresh_token')
  })

  describe('the quota 403 (PERMISSION_DENIED, rateLimitExceeded, usageLimits, details[]) with no Retry-After', () => {
    const quota = () => new GmailApiError({ status: 403, gmailStatus: 'PERMISSION_DENIED', reason: 'rateLimitExceeded' })
    it.each([
      ['messages list', 'recorded-messages-list-403', '/messages?q=after%3A1&maxResults=25'],
      ['message full', 'recorded-message-full-403', '/messages/q1?format=full'],
      ['message raw', 'recorded-message-raw-403', '/messages/q1?format=raw'],
    ])('%s', async (_n, file, path) => {
      const g = new FakeGmail([alternative('q1', ['INBOX'])]).failWhen(() => true, quota())
      const { res, body } = await call(g, path)
      expect(res.status).toBe(403)
      expect(res.headers.get('retry-after')).toBeNull()
      same(file, body)
      expect(body).toMatchObject({ error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }] } })
    })
    it('an attachment get answers the same body', async () => {
      const g = new FakeGmail([gmailFixture('attachment')]).failWhen((c) => c.op === 'attachment', quota())
      const { res, body } = await call(g, '/messages/with-attachment/attachments/att-pdf')
      expect(res.status).toBe(403)
      same('recorded-messages-list-403', body)
    })
    it('a Retry-After the test scripts is still sent', async () => {
      const g = new FakeGmail([alternative('q1', ['INBOX'])]).failWhen(() => true, new GmailApiError({ status: 403, reason: 'rateLimitExceeded', retryAfter: '9', retryAfterSeconds: 9 }))
      expect((await call(g, '/messages/q1?format=full')).res.headers.get('retry-after')).toBe('9')
    })
  })
})

describe('base64url is padded with "=" as Google pads it (D82 d)', () => {
  const lens = [1, 2, 3, 4, 5, 6, 7]
  const ok = (s: string, bytes: number): void => {
    expect(s).toMatch(/^[A-Za-z0-9_-]*={0,2}$/)
    expect(s.length % 4).toBe(0)
    expect(atob(s.replace(/-/g, '+').replace(/_/g, '/')).length).toBe(bytes)
  }
  it.each(lens)('an attachment of %i bytes', (n) => {
    const wire = JSON.parse(new TextDecoder().decode(attachmentWire(Uint8Array.from({ length: n }, (_, i) => 250 - i)))) as { data: string }
    ok(wire.data, n)
  })
  it.each(lens)('a raw original of %i bytes', (n) => {
    const m = buildGmailMessage({ id: 'p', headers: [['Subject', 's']], payload: { mimeType: 'text/plain', text: 'x' }, rawOverride: Uint8Array.from({ length: n }, (_, i) => 200 + i) })
    ok((JSON.parse(new TextDecoder().decode(rawWire(m))) as { raw: string }).raw, n)
  })
  it.each(lens)('a body part of %i bytes', (n) => {
    const m = buildGmailMessage({ id: 'p', headers: [['Subject', 's']], payload: { mimeType: 'text/plain', text: 'a'.repeat(n) } })
    ok(m.resource.payload!.body!.data!, n)
  })
  it('the first three lengths show all three paddings', () => {
    const pads = lens.map((n) => /=*$/.exec((JSON.parse(new TextDecoder().decode(attachmentWire(new Uint8Array(n)))) as { data: string }).data)![0].length)
    expect(new Set(pads)).toEqual(new Set([0, 1, 2]))
  })
})

beforeAll(() => {
  // a recorded file is never regenerated: the shapes above read the committed files
  expect(recorded('recorded-messages-list-200').recording.source).toBe('recorded')
})
