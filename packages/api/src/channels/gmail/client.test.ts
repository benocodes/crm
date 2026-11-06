import { describe, expect, it } from 'vitest'
import { GmailApiError, HttpGmailClient } from './client.js'

// [[CHN5]] D44, D46: the three read calls over `fetch` with an injected access-token function.
const TOKEN = 'ya29.SECRET-TOKEN-VALUE'
interface Seen {
  url: string
  method: string | undefined
  authorization: string | null
}
function harness(respond: (n: number) => Response, tokens: string[] = [TOKEN]) {
  const seen: Seen[] = []
  let tokenCalls = 0
  const client = new HttpGmailClient({
    accessToken: async () => tokens[Math.min(tokenCalls++, tokens.length - 1)]!,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get('authorization') })
      return respond(seen.length)
    }) as typeof fetch,
  })
  return { client, seen, tokenCalls: () => tokenCalls }
}
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })
const B = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

describe('HttpGmailClient requests', () => {
  it('getMessageFull: GET format=full, path-encoded id, bearer token, parsed JSON', async () => {
    const h = harness(() => json({ id: 'a/b c', threadId: 't' }))
    expect(await h.client.getMessageFull('a/b c')).toEqual({ id: 'a/b c', threadId: 't' })
    expect(h.seen).toEqual([{ url: `${B}/a%2Fb%20c?format=full`, method: 'GET', authorization: `Bearer ${TOKEN}` }])
  })

  it('getMessageRaw: format=raw, and the id is path-encoded', async () => {
    const h = harness(() => new Response('{"raw":"QQ"}'))
    await h.client.getMessageRaw('x?y=1#z')
    expect(h.seen[0]!.url).toBe(`${B}/x%3Fy%3D1%23z?format=raw`)
  })

  it('getAttachment: the attachments path, both ids encoded', async () => {
    const h = harness(() => new Response('{"data":"QQ"}'))
    await h.client.getAttachment('m/1', 'att id+/=')
    expect(h.seen[0]!.url).toBe(`${B}/m%2F1/attachments/att%20id%2B%2F%3D`)
  })

  it('asks the token function before every request and uses what it returns', async () => {
    const h = harness(() => json({ id: 'a', threadId: 't' }), ['tok-1', 'tok-2', 'tok-3'])
    await h.client.getMessageFull('a')
    await h.client.getMessageFull('a')
    await h.client.getMessageRaw('a').catch(() => {})
    expect(h.seen.map((s) => s.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-3'])
    expect(h.tokenCalls()).toBe(3)
  })

  it('returns a streaming body without reading it (raw and attachment)', async () => {
    for (const call of [(c: HttpGmailClient) => c.getMessageRaw('a'), (c: HttpGmailClient) => c.getAttachment('a', 'b')]) {
      let pulls = 0
      const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode('{"raw":"QQ"}')); c.close() } }, { highWaterMark: 0 })
      const h = harness(() => new Response(body))
      const stream = await call(h.client)
      expect(pulls).toBe(0)
      expect(await new Response(stream).text()).toBe('{"raw":"QQ"}')
      expect(pulls).toBe(1)
    }
  })
})

describe('HttpGmailClient errors', () => {
  it('a non-2xx is a GmailApiError with status, Gmail status and reason, and Retry-After', async () => {
    const body = { error: { code: 429, message: 'User-rate limit exceeded', status: 'RESOURCE_EXHAUSTED', errors: [{ reason: 'userRateLimitExceeded', message: 'x' }] } }
    const h = harness(() => json(body, { status: 429, headers: { 'retry-after': '30' } }))
    for (const call of [() => h.client.getMessageFull('a'), () => h.client.getMessageRaw('a'), () => h.client.getAttachment('a', 'b')]) {
      const err = await call().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(GmailApiError)
      expect(err).toMatchObject({ status: 429, gmailStatus: 'RESOURCE_EXHAUSTED', reason: 'userRateLimitExceeded', retryAfter: '30', retryAfterSeconds: 30 })
    }
  })

  it('Retry-After as an HTTP date becomes seconds from now', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString()
    const h = harness(() => json({}, { status: 503, headers: { 'retry-after': date } }))
    const err = (await h.client.getMessageFull('a').catch((e: unknown) => e)) as GmailApiError
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(55)
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('a non-JSON error body still gives the status', async () => {
    const h = harness(() => new Response('<html>bad gateway</html>', { status: 502 }))
    const err = (await h.client.getMessageFull('a').catch((e: unknown) => e)) as GmailApiError
    expect(err).toMatchObject({ status: 502, gmailStatus: null, reason: null, retryAfter: null, retryAfterSeconds: null })
  })

  it('404 carries NOT_FOUND', async () => {
    const h = harness(() => json({ error: { code: 404, status: 'NOT_FOUND', errors: [{ reason: 'notFound' }] } }, { status: 404 }))
    expect(await h.client.getMessageFull('a').catch((e: unknown) => e)).toMatchObject({ status: 404, gmailStatus: 'NOT_FOUND', reason: 'notFound' })
  })

  it('the token never appears in an error, its message, its string form or its JSON, even when the response echoes it', async () => {
    const h = harness(() => json({ error: { code: 401, status: 'UNAUTHENTICATED', message: `Bearer ${TOKEN} is invalid`, errors: [{ reason: 'authError' }] } }, { status: 401 }))
    const err = (await h.client.getMessageFull('a').catch((e: unknown) => e)) as GmailApiError
    for (const text of [err.message, String(err), JSON.stringify(err), err.stack ?? '', Object.values(err).join('|')]) expect(text).not.toContain(TOKEN)
    expect(err.message).toContain('401')
  })
})

// CHN140 D46: the two account calls the connect flow adds.
describe('HttpGmailClient account calls (CHN140)', () => {
  const U = 'https://gmail.googleapis.com/gmail/v1/users/me'

  it('getProfile: GET users/me/profile with the bearer token, parsed', async () => {
    const h = harness(() => json({ emailAddress: 'ann@example.test', historyId: '4242', messagesTotal: 3, threadsTotal: 2 }))
    expect(await h.client.getProfile()).toMatchObject({ emailAddress: 'ann@example.test', historyId: '4242' })
    expect(h.seen).toEqual([{ url: `${U}/profile`, method: 'GET', authorization: `Bearer ${TOKEN}` }])
  })

  it('listSendAs: GET users/me/settings/sendAs and returns the entries (an empty answer is an empty list)', async () => {
    const h = harness(() => json({ sendAs: [{ sendAsEmail: 'ann@example.test', isPrimary: true }, { sendAsEmail: 'sales@example.test', verificationStatus: 'accepted' }] }))
    expect(await h.client.listSendAs()).toEqual([{ sendAsEmail: 'ann@example.test', isPrimary: true }, { sendAsEmail: 'sales@example.test', verificationStatus: 'accepted' }])
    expect(h.seen[0]!.url).toBe(`${U}/settings/sendAs`)
    expect(await harness(() => json({})).client.listSendAs()).toEqual([])
  })

  it('a non-2xx on either is a GmailApiError carrying neither the token nor the URL', async () => {
    for (const call of ['getProfile', 'listSendAs'] as const) {
      const h = harness(() => json({ error: { status: 'UNAUTHENTICATED' } }, { status: 401 }))
      const err = await h.client[call]().catch((e: Error) => e)
      expect(err).toBeInstanceOf(GmailApiError)
      expect(String((err as Error).message)).not.toContain(TOKEN)
      expect((err as GmailApiError).status).toBe(401)
    }
  })

  it('the FakeGmail counterparts answer the same shapes and record their calls', async () => {
    const { FakeGmail } = await import('../../test/gmail.js')
    const fake = new FakeGmail([], { profile: { emailAddress: 'ann@example.test', historyId: '77' }, sendAs: [{ sendAsEmail: 'ann@example.test', isPrimary: true }] })
    expect(await fake.getProfile()).toEqual({ emailAddress: 'ann@example.test', historyId: '77' })
    expect(await fake.listSendAs()).toEqual([{ sendAsEmail: 'ann@example.test', isPrimary: true }])
    expect(fake.accountCalls).toEqual(['profile', 'send_as'])
  })
})

// [[CHN155]] D46, D89, D91: `users.watch` and `users.stop`.
const U = 'https://gmail.googleapis.com/gmail/v1/users/me'
describe('HttpGmailClient watch and stop', () => {
  function post(respond: () => Response) {
    const seen: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = []
    const client = new HttpGmailClient({
      accessToken: async () => TOKEN,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body })
        return respond()
      }) as typeof fetch,
    })
    return { client, seen }
  }
  it('watch: POST /watch with the topic, INBOX and SENT, include behaviour (lowercase, as the reference enum), a JSON content type and the bearer token', async () => {
    const h = post(() => json({ historyId: '1234', expiration: '1793700000000' }))
    const out = await h.client.watch({ topicName: 'projects/p/topics/t' })
    expect(out).toEqual({ historyId: '1234', expiration: '1793700000000' })
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]!.url).toBe(`${U}/watch`)
    expect(h.seen[0]!.method).toBe('POST')
    expect(h.seen[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(h.seen[0]!.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(h.seen[0]!.body as string)).toEqual({ topicName: 'projects/p/topics/t', labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' })
  })
  it.each([
    ['no expiration', { historyId: '1' }],
    ['no historyId', { expiration: '1793700000000' }],
    ['a numeric expiration (Google sends a string)', { historyId: '1', expiration: 1793700000000 }],
    ['an expiration that is not epoch milliseconds', { historyId: '1', expiration: 'tomorrow' }],
    ['an empty object', {}],
  ])('watch: %s is a failure, never a guessed expiry', async (_n, body) => {
    const h = post(() => json(body))
    await expect(h.client.watch({ topicName: 't' })).rejects.toMatchObject({ name: 'GmailApiError', reason: 'bad_watch_response' })
  })
  it('watch: a non-2xx is a GmailApiError with status and reason, carrying neither the topic nor the token', async () => {
    const h = post(() => json({ error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } }, { status: 403 }))
    const err = await h.client.watch({ topicName: 'projects/secret/topics/t' }).catch((x) => x)
    expect(err).toBeInstanceOf(GmailApiError)
    expect(err).toMatchObject({ status: 403, gmailStatus: 'PERMISSION_DENIED', reason: 'forbidden' })
    expect(JSON.stringify(err) + err.message).not.toContain('secret')
    expect(JSON.stringify(err) + err.message).not.toContain(TOKEN)
  })
  it('stop: POST /stop with an empty body and the bearer token; an empty 2xx is success', async () => {
    const h = post(() => new Response(null, { status: 204 }))
    await expect(h.client.stop()).resolves.toBeUndefined()
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]!.url).toBe(`${U}/stop`)
    expect(h.seen[0]!.method).toBe('POST')
    expect(h.seen[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(h.seen[0]!.body === undefined || h.seen[0]!.body === '' || h.seen[0]!.body === null).toBe(true)
  })
  it('stop: a non-2xx is a GmailApiError', async () => {
    const h = post(() => json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 }))
    await expect(h.client.stop()).rejects.toMatchObject({ status: 401, gmailStatus: 'UNAUTHENTICATED' })
  })
})
