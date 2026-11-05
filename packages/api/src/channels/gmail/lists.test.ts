import { describe, expect, it } from 'vitest'
import { FakeGmail } from '../../test/gmail.js'
import { GmailApiError, HttpGmailClient } from './client.js'

// [[CHN149]] "Wire forms" ([[CHN5]] D46, D72): history and messages list parse Google's documented bodies, and FakeGmail serves the same forms.
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
function harness(body: unknown, status = 200) {
  const seen: string[] = []
  const client = new HttpGmailClient({
    accessToken: async () => 'tok',
    fetch: (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  return { client, seen }
}

// Copied from the users.history.list reference (shape), with an unknown field and a record of another kind.
const DOC_HISTORY = {
  history: [
    { id: '2001', messages: [{ id: 'm1', threadId: 't1' }], messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] } }] },
    { id: '2002', labelsAdded: [{ message: { id: 'm2', threadId: 't2' }, labelIds: ['STARRED'] }] },
    { id: '2003', messagesDeleted: [{ message: { id: 'm3', threadId: 't3' } }], somethingNew: true },
    { id: '2004', messagesAdded: [{ message: { id: 'm4', threadId: 't4' } }] },
  ],
  nextPageToken: 'tok-2',
  historyId: '2010',
  futureField: { a: 1 },
}
// Copied from the users.messages.list reference (shape).
const DOC_LIST = { messages: [{ id: 'a1', threadId: 'ta1' }, { id: 'a2', threadId: 'ta2' }], nextPageToken: 'next', resultSizeEstimate: 7 }

describe('users.history.list', () => {
  it('requests startHistoryId, maxResults, one historyTypes per type and the page token', async () => {
    const h = harness(DOC_HISTORY)
    await h.client.listHistory({ startHistoryId: '1000', pageToken: 'pt', maxResults: 25, historyTypes: ['messageAdded'] })
    const url = new URL(h.seen[0]!)
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/history`)
    expect(url.searchParams.get('startHistoryId')).toBe('1000')
    expect(url.searchParams.get('maxResults')).toBe('25')
    expect(url.searchParams.getAll('historyTypes')).toEqual(['messageAdded'])
    expect(url.searchParams.get('pageToken')).toBe('pt')
  })

  it('parses the documented body: only messagesAdded is read, labelIds optional, unknown fields ignored', async () => {
    const h = harness(DOC_HISTORY)
    const page = await h.client.listHistory({ startHistoryId: '1', maxResults: 25, historyTypes: ['messageAdded'] })
    expect(page).toEqual({
      history: [
        { id: '2001', messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] } }] },
        { id: '2002', messagesAdded: [] },
        { id: '2003', messagesAdded: [] },
        { id: '2004', messagesAdded: [{ message: { id: 'm4', threadId: 't4' } }] },
      ],
      nextPageToken: 'tok-2',
      historyId: '2010',
    })
  })

  it('an empty page has no history member and the last page no nextPageToken: both parse as empty and null', async () => {
    const h = harness({ historyId: '2020' })
    expect(await h.client.listHistory({ startHistoryId: '1', maxResults: 25, historyTypes: ['messageAdded'] })).toEqual({ history: [], nextPageToken: null, historyId: '2020' })
  })

  it('a 404 is a GmailApiError with status 404', async () => {
    const h = harness({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404)
    await expect(h.client.listHistory({ startHistoryId: '1', maxResults: 25, historyTypes: ['messageAdded'] })).rejects.toMatchObject({ name: 'GmailApiError', status: 404 })
  })
})

describe('users.messages.list', () => {
  it('requests q, maxResults and the page token, and parses the documented body', async () => {
    const h = harness(DOC_LIST)
    const page = await h.client.listMessages({ q: 'after:1 {in:inbox in:sent}', pageToken: 'p', maxResults: 25 })
    const url = new URL(h.seen[0]!)
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/messages`)
    expect(url.searchParams.get('q')).toBe('after:1 {in:inbox in:sent}')
    expect(url.searchParams.get('maxResults')).toBe('25')
    expect(url.searchParams.get('pageToken')).toBe('p')
    expect(url.searchParams.has('includeSpamTrash')).toBe(false)
    expect(page).toEqual({ messages: [{ id: 'a1', threadId: 'ta1' }, { id: 'a2', threadId: 'ta2' }], nextPageToken: 'next' })
  })

  it('no matches: the body has no messages member', async () => {
    const h = harness({ resultSizeEstimate: 0 })
    expect(await h.client.listMessages({ q: 'x', maxResults: 25 })).toEqual({ messages: [], nextPageToken: null })
  })
})

describe('FakeGmail serves the same wire forms', () => {
  const fake = () => {
    const f = new FakeGmail()
    f.history.push({ id: '2001', added: [{ id: 'm1', labels: ['INBOX'] }] }, { id: '2002', labelsAdded: [{ id: 'm1', labelIds: ['STARRED'] }] }, { id: '2003', added: [{ id: 'm2' }] })
    f.profile.historyId = '2003'
    return f
  }
  it('an empty page has no history member; the last page has no nextPageToken; labelIds only where scripted', () => {
    const f = fake()
    const first = f.historyWire('1000', null, 2) as { history: Array<Record<string, unknown>>; nextPageToken?: string }
    expect(first.history.map((r) => r.id)).toEqual(['2001', '2002'])
    expect(first.nextPageToken).toBeDefined()
    expect(first.history[0]).toMatchObject({ messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] })
    expect(first.history[1]).toHaveProperty('labelsAdded')
    expect(first.history[1]).not.toHaveProperty('messagesAdded')
    const last = f.historyWire('1000', first.nextPageToken, 2) as { history: Array<{ messagesAdded: Array<{ message: Record<string, unknown> }> }> } & Record<string, unknown>
    expect(last).not.toHaveProperty('nextPageToken')
    expect(last.history[0]!.messagesAdded[0]!.message).not.toHaveProperty('labelIds')
    const empty = f.historyWire('2003', null, 25)
    expect(empty).not.toHaveProperty('history')
    expect(empty).not.toHaveProperty('nextPageToken')
    expect(empty).toMatchObject({ historyId: '2003' })
  })
  it('an expired start id is a 404 GmailApiError', async () => {
    const f = fake()
    f.expireHistoryBefore = 500
    await expect(f.listHistory({ startHistoryId: '100', maxResults: 25, historyTypes: ['messageAdded'] })).rejects.toSatisfy((e) => e instanceof GmailApiError && e.status === 404)
  })
  it('an empty message list has no messages member', () => {
    expect(new FakeGmail().messageListWire('after:1 {in:inbox in:sent}', null, 25)).not.toHaveProperty('messages')
  })
})
