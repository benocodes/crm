import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeR2Bucket, type FakeR2Bucket } from '../../test/objects.js'
import { RECORDINGS_INDEX_KEY, RECORDING_CAP, createRecordingFetch, googleRecording, maskText, parseRecordingSwitch, summarizeBase64, type RecordedExchange } from './recorder.js'

// [[CHN5]] D78, D79 ([[CHN153]]): the recorder's switch, host filter, redaction, shapes, transparency, caps and failure behaviour.
const NOW = new Date('2026-11-06T10:00:00.000Z')
const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (s: string): string => btoa(s)
const b64url = (s: string | Uint8Array): string => btoa(typeof s === 'string' ? s : String.fromCharCode(...s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** Deterministic, never equal to the input class's own characters by construction of the recorder's retry: a counter stream. */
const counter = (): ((n: number) => Uint8Array) => {
  let c = 7
  return (n) => Uint8Array.from({ length: n }, () => (c = (c * 31 + 17) % 251))
}
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })

function rig(plain: (url: string, init?: RequestInit) => Response | Promise<Response>, opts: { bucket?: FakeR2Bucket; until?: Date; log?: string[]; start?: Date } = {}) {
  const bucket = opts.bucket ?? fakeR2Bucket()
  const log = opts.log ?? []
  const seen: Array<{ url: string; init?: RequestInit }> = []
  const f = createRecordingFetch({
    plain: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return plain(String(input), init)
    }) as typeof fetch,
    bucket,
    run: { id: 'run-1', start: opts.start ?? NOW },
    clock: () => NOW,
    until: opts.until ?? new Date(NOW.getTime() + 86_400_000),
    random: counter(),
    log: (l) => log.push(l),
  })
  return { f, bucket, log, seen }
}
const G = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const recorded = (bucket: FakeR2Bucket): Array<{ key: string; rec: RecordedExchange }> =>
  [...bucket.objects.entries()].filter(([k]) => k.startsWith('_recordings/') && k !== RECORDINGS_INDEX_KEY).map(([key, v]) => ({ key, rec: JSON.parse(dec.decode(v)) as RecordedExchange }))
const allBytes = (bucket: FakeR2Bucket): string => [...bucket.objects.values()].map((v) => dec.decode(v)).join('\n')
const drain = async (res: Response): Promise<string> => await res.text()

describe('the switch (D78)', () => {
  const at = (raw: string | undefined) => parseRecordingSwitch(raw, NOW)
  it('is on only for an ISO-8601 UTC instant that is ahead and at most 7 days away', () => {
    expect(at('2026-11-07T10:00:00Z').until?.toISOString()).toBe('2026-11-07T10:00:00.000Z')
    expect(at('2026-11-13T10:00:00.000Z').until).not.toBeNull()
  })
  it('absent, empty and past are off without a problem', () => {
    for (const raw of [undefined, '', '2026-11-06T10:00:00Z', '2026-11-05T10:00:00Z']) expect(at(raw)).toEqual({ until: null, problem: null })
  })
  it('malformed is off with a "malformed" problem (a date without a zone, a local offset, text)', () => {
    for (const raw of ['tomorrow', '2026-11-07', '2026-11-07T10:00:00', '2026-11-07T10:00:00+01:00', '2026-02-30T10:00:00Z', '1']) expect(at(raw)).toEqual({ until: null, problem: 'malformed' })
  })
  it('more than 7 days ahead is off with a "too_far" problem', () => {
    expect(at('2026-11-13T10:00:00.001Z')).toEqual({ until: null, problem: 'too_far' })
    expect(at('2027-01-01T00:00:00Z')).toEqual({ until: null, problem: 'too_far' })
  })
})

describe('off by default (empty state included)', () => {
  const plain = (async () => new Response('x')) as typeof fetch
  for (const [label, raw] of [['absent', undefined], ['past', '2026-11-05T10:00:00Z'], ['malformed', 'soon'], ['over 7 days', '2026-12-31T00:00:00Z']] as const) {
    it(`${label}: the composition hands over the plain fetch itself, and nothing is written`, async () => {
      const bucket = fakeR2Bucket()
      const log: string[] = []
      const rec = googleRecording({ raw, bucket, clock: () => NOW, plain, log: (l) => log.push(l) })
      expect(rec.on).toBe(false)
      expect(rec.fetchFor({ id: 'r', start: NOW })).toBe(plain)
      await rec.fetchFor({ id: 'r', start: NOW })!(`${G}/profile`)
      expect(bucket.calls).toEqual([])
      // Malformed and too far are logged by name; the value never is.
      const noted = log.join('\n')
      expect(noted.includes(raw ?? '\u0000')).toBe(false)
      if (raw === 'soon' || raw === '2026-12-31T00:00:00Z') expect(noted).toContain('GOOGLE_RECORDING_UNTIL')
      else expect(log).toEqual([])
    })
  }
  it('without a BODIES bucket it is off even with a valid switch', () => {
    expect(googleRecording({ raw: '2026-11-07T10:00:00Z', bucket: undefined, clock: () => NOW, plain }).on).toBe(false)
  })
  it('a valid switch with a bucket is on and hands over a different fetch', () => {
    const rec = googleRecording({ raw: '2026-11-07T10:00:00Z', bucket: fakeR2Bucket(), clock: () => NOW, plain })
    expect(rec.on).toBe(true)
    expect(rec.fetchFor({ id: 'r', start: NOW })).not.toBe(plain)
  })
  it('records nothing once the clock passes `until`, within one run', async () => {
    const bucket = fakeR2Bucket()
    let now = NOW
    const f = createRecordingFetch({ plain: (async () => jsonRes({ emailAddress: 'a@b.test', historyId: '5' })) as typeof fetch, bucket, run: { id: 'r', start: NOW }, clock: () => now, until: new Date(NOW.getTime() + 1000), random: counter(), log: () => {} })
    await drain(await f(`${G}/profile`))
    now = new Date(NOW.getTime() + 2000)
    await drain(await f(`${G}/profile`))
    expect(recorded(bucket)).toHaveLength(1)
  })
})

describe('host filter', () => {
  it('Clerk, JWKS and every other host pass through unrecorded; Google JWKS is not the token endpoint', async () => {
    const { f, bucket } = rig(() => jsonRes({ keys: [] }))
    for (const url of ['https://api.clerk.com/v1/users/user_1', 'https://clerk.hq.vibase.ai/.well-known/jwks.json', 'https://www.googleapis.com/oauth2/v3/certs', 'https://oauth2.googleapis.com/other', 'https://example.test/gmail/v1/users/me/profile']) {
      expect(await drain(await f(url))).toBe('{"keys":[]}')
    }
    expect(bucket.calls).toEqual([])
  })
  it('Gmail and the token endpoint are recorded', async () => {
    const { f, bucket } = rig(() => jsonRes({ emailAddress: 'a@b.test', historyId: '5', access_token: 'zzz', expires_in: 3599 }))
    await drain(await f(`${G}/profile`))
    await drain(await f(TOKEN_URL, { method: 'POST', body: 'grant_type=refresh_token&refresh_token=r' }))
    expect(recorded(bucket).map((r) => r.rec.kind).sort()).toEqual(['profile', 'token_refresh'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The canary suite (D79)

const CANARIES = {
  auth: 'CANARYauthHDR91',
  secret: 'CANARYclientSECRET62',
  refreshIn: 'CANARYrefreshIN73',
  code: 'CANARYcodeIN84',
  access: 'CANARYaccessOUT15',
  refreshOut: 'CANARYrefreshOUT26',
  sub: 'CANARYsubCLAIM37',
  idEmail: 'canaryidmail48@canary-claims.test',
  aud: 'CANARYaudCLAIM59',
  from: 'CANARYfromNAME11',
  fromAddr: 'canaryfromaddr22@canary-mail.test',
  to: 'CANARYtoNAME33',
  subject: 'CANARYsubjectLINE44',
  word: 'CANARYencodedWORD55',
  snippet: 'CANARYsnippetTEXT66',
  filename: 'CANARYfileNAME77',
  bodyData: 'CANARYbodyDATA88 and more text so the member is long enough to matter',
  raw: 'CANARYrawORIGINAL99 From: a@b.test\r\n\r\nbody text',
  attachment: 'CANARYattachmentBYTES10',
  errorAddr: 'canaryerroraddr21@canary-error.test',
  unknown: 'CANARYunknownFIELD32',
  unknownNested: 'CANARYunknownNESTED43',
  ctParam: 'CANARYctPARAM54',
  nonAscii: 'CANARYunicodeÉÜ65',
  semiName: 'CANARYsemiNAMEparam76',
  semiFile: 'CANARYsemiFILEparam87',
} as const
const jwt = (claims: object): string => `${b64url('{"alg":"RS256","kid":"k1","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.${b64url('signature-bytes')}`

/** Every form a canary could survive in: itself, base64 at all three alignments, base64url, percent-encoded. */
function forms(canary: string): string[] {
  const out = new Set<string>([canary, encodeURIComponent(canary), b64(canary).replace(/=+$/, ''), b64url(canary)])
  for (let k = 0; k < 3; k++) {
    const e = btoa('x'.repeat(k) + canary).replace(/=+$/, '')
    out.add(e.slice(Math.ceil((k * 4) / 3), e.length - 2))
    out.add(e.slice(Math.ceil((k * 4) / 3), e.length - 2).replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return [...out].filter((s) => s.length >= 8)
}

async function recordCanaryRun() {
  const C = CANARIES
  const routes: Array<[RegExp, () => Response]> = [
    [/oauth2\.googleapis\.com\/token/, () => jsonRes({ access_token: C.access, refresh_token: C.refreshOut, id_token: jwt({ iss: 'https://accounts.google.com', sub: C.sub, email: C.idEmail, email_verified: true, aud: C.aud, exp: 1799999999 }), expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' })],
    [/\/messages\/MSG1\?format=full/, () =>
      jsonRes({
        id: 'MSG1',
        threadId: 'THR1',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: C.snippet,
        historyId: '4242',
        internalDate: '1791000000000',
        sizeEstimate: 5120,
        x_unknown_field: C.unknown,
        x_unknown_object: { inner: C.unknownNested, list: [C.unknownNested] },
        payload: {
          partId: '',
          mimeType: 'multipart/mixed',
          filename: '',
          headers: [
            { name: 'From', value: `"${C.from}" <${C.fromAddr}>` },
            { name: 'To', value: C.to },
            { name: 'Subject', value: C.subject },
            { name: 'X-Encoded', value: `=?UTF-8?B?${b64(C.word)}?= tail` },
            { name: 'Content-Type', value: `multipart/mixed; boundary="${C.ctParam}"` },
            { name: 'X-Unicode', value: C.nonAscii },
          ],
          body: { size: 0 },
          parts: [
            { partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { size: C.bodyData.length, data: b64url(C.bodyData) } },
            { partId: '2', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: `text/plain; name="a;${C.semiName}=1"` }, { name: 'Content-Disposition', value: `attachment; filename="Invoice; ${C.semiFile}=Q3.pdf"` }], body: { size: 0 } },
            { partId: '1', mimeType: 'application/pdf', filename: `${C.filename}.pdf`, headers: [{ name: 'Content-Disposition', value: `attachment; filename="${C.filename}.pdf"` }], body: { size: 9, attachmentId: 'ATT1' } },
          ],
        },
      })],
    [/\/messages\/MSG1\?format=raw/, () => jsonRes({ id: 'MSG1', threadId: 'THR1', labelIds: ['INBOX'], sizeEstimate: 5120, raw: b64url(C.raw) })],
    [/\/attachments\/ATT1/, () => jsonRes({ size: 9, data: b64url(C.attachment) })],
    [/\/messages\/GONE\?format=full/, () => jsonRes({ error: { code: 404, message: `Requested entity ${C.errorAddr} was not found.`, errors: [{ message: `Not Found ${C.errorAddr}`, domain: 'global', reason: 'notFound' }], status: 'NOT_FOUND' } }, 404)],
    [/\/messages\/BADREQ\?format=full/, () => jsonRes({ error: { code: 400, message: 'Invalid id value', errors: [{ message: 'Invalid id value', domain: 'global', reason: 'invalidArgument' }], status: 'INVALID_ARGUMENT' } }, 400)],
  ]
  const { f, bucket } = rig((url) => (routes.find(([re]) => re.test(url)) ?? [null, () => jsonRes({})])[1]())
  await drain(await f(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: C.refreshIn, client_id: 'cid', client_secret: C.secret }).toString() }))
  await drain(await f(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: C.code, client_secret: C.secret, client_id: 'cid', redirect_uri: 'https://w.test/cb', code_verifier: C.code }).toString() }))
  const auth = { headers: { authorization: `Bearer ${C.auth}` } }
  for (const path of ['/messages/MSG1?format=full', '/messages/MSG1?format=raw', '/messages/MSG1/attachments/ATT1', '/messages/GONE?format=full', '/messages/BADREQ?format=full']) await drain(await f(`${G}${path}`, auth))
  return bucket
}

describe('no secret or content survives (canary suite)', () => {
  it('none of the canaries, in any encoding, appears in any written byte', async () => {
    const bucket = await recordCanaryRun()
    expect(recorded(bucket).length).toBeGreaterThanOrEqual(7)
    const written = allBytes(bucket)
    for (const [name, canary] of Object.entries(CANARIES)) {
      for (const form of forms(canary)) expect({ name, leaked: written.includes(form) ? form : null }).toEqual({ name, leaked: null })
    }
    // Words that would show a header or a bearer token was recorded at all.
    expect(written).not.toMatch(/"authorization"|Bearer [A-Za-z0-9]/i)
  })
  it('secrets leave nothing: tokens are "<redacted>", the id_token is a summary, the token POST keeps its form keys and only grant_type', async () => {
    const bucket = await recordCanaryRun()
    const by = (kind: string) => recorded(bucket).filter((r) => r.rec.kind === kind).map((r) => r.rec)
    const refresh = by('token_refresh')[0]!
    expect(refresh.request.form).toEqual({ grant_type: 'refresh_token', refresh_token: '<redacted>', client_id: '<redacted>', client_secret: '<redacted>' })
    expect(refresh.response.body).toMatchObject({ access_token: '<redacted>', refresh_token: '<redacted>', expires_in: 3599, token_type: 'Bearer', scope: 'openid https://www.googleapis.com/auth/gmail.readonly' })
    const idToken = (refresh.response.body as { id_token: unknown }).id_token
    expect(idToken).toEqual({ alg: 'RS256', claims: { iss: 'string', sub: 'string', email: 'string', email_verified: 'boolean', aud: 'string', exp: 'number' }, iss: 'https://accounts.google.com', email_verified: true })
    const exchange = by('token_exchange')[0]!
    expect(exchange.request.form).toMatchObject({ grant_type: 'authorization_code', code: '<redacted>', client_secret: '<redacted>' })
  })
  it('base64url members (raw, a part body.data, an attachment data) are summaries, never content', async () => {
    const bucket = await recordCanaryRun()
    const kind = (k: string) => recorded(bucket).find((r) => r.rec.kind === k)!.rec.response.body as Record<string, any>
    expect(kind('message_raw').raw).toEqual(summarizeBase64(b64url(CANARIES.raw)))
    expect(kind('attachment_get').data).toEqual(summarizeBase64(b64url(CANARIES.attachment)))
    expect(kind('message_full').payload.parts[0].body.data).toEqual(summarizeBase64(b64url(CANARIES.bodyData)))
  })
  it('deny by default: a member the allow-list does not know is masked, whatever its depth', async () => {
    const bucket = await recordCanaryRun()
    const full = recorded(bucket).find((r) => r.rec.kind === 'message_full')!.rec.response.body as Record<string, any>
    expect(full.x_unknown_field).toBe(maskText(CANARIES.unknown))
    expect(full.x_unknown_field).toMatch(/^[xX0]+$/)
    expect(full.x_unknown_object).toEqual({ inner: maskText(CANARIES.unknownNested), list: [maskText(CANARIES.unknownNested)] })
    expect(full.snippet).toBe(maskText(CANARIES.snippet))
  })
  it('a Gmail error keeps code, status and reason; an echoed address is masked and errors[].message is masked', async () => {
    const bucket = await recordCanaryRun()
    const errs = recorded(bucket).filter((r) => r.rec.response.status === 404 || r.rec.response.status === 400).map((r) => r.rec)
    const gone = errs.find((r) => r.response.status === 404)!.response.body as { error: { code: number; status: string; message: string; errors: Array<{ reason: string; domain: string; message: string }> } }
    expect(gone.error).toMatchObject({ code: 404, status: 'NOT_FOUND' })
    expect(gone.error.errors[0]).toMatchObject({ reason: 'notFound', domain: 'global' })
    expect(gone.error.message).toContain('Requested entity')
    expect(gone.error.errors[0]!.message).toBe(maskText(`Not Found ${CANARIES.errorAddr}`))
    const bad = errs.find((r) => r.response.status === 400)!.response.body as { error: { message: string } }
    expect(bad.error.message).toBe('Invalid id value')
  })
  it('header names, Content-Type media types and parameter names stay; values, RFC 2047 text and parameter values are masked', async () => {
    const bucket = await recordCanaryRun()
    const full = recorded(bucket).find((r) => r.rec.kind === 'message_full')!.rec.response.body as { payload: { headers: Array<{ name: string; value: string }>; parts: Array<{ partId: string; headers: Array<{ name: string; value: string }>; filename: string }> } }
    const h = Object.fromEntries(full.payload.headers.map((x) => [x.name, x.value]))
    expect(Object.keys(h)).toEqual(['From', 'To', 'Subject', 'X-Encoded', 'Content-Type', 'X-Unicode'])
    expect(h.From).toBe(maskText(`"${CANARIES.from}" <${CANARIES.fromAddr}>`))
    expect(h['X-Encoded']).toMatch(/^=\?UTF-8\?B\?[xX0+/=]+\?= xxxx$/)
    expect(h['Content-Type']).toBe(`multipart/mixed; boundary="${maskText(CANARIES.ctParam)}"`)
    expect(h['X-Unicode']).toMatch(/^[xX0]+$/)
    expect(full.payload.parts.find((p: any) => p.partId === '1')!.headers[0]!.value).toBe(`attachment; filename="${maskText(`${CANARIES.filename}.pdf`)}"`)
    expect(full.payload.parts.find((p: any) => p.partId === '1')!.filename).toBe(maskText(`${CANARIES.filename}.pdf`))
  })
  it('a ";" inside a quoted parameter value does not split the parameter: nothing after it is kept as a parameter name', async () => {
    const bucket = await recordCanaryRun()
    const full = recorded(bucket).find((r) => r.rec.kind === 'message_full')!.rec.response.body as { payload: { parts: Array<{ partId: string; headers: Array<{ name: string; value: string }> }> } }
    const part = full.payload.parts.find((p) => p.partId === '2')!
    expect(part.headers[0]!.value).toBe(`text/plain; name="${maskText(`a;${CANARIES.semiName}=1`)}"`)
    expect(part.headers[1]!.value).toBe(`attachment; filename="${maskText(`Invoice; ${CANARIES.semiFile}=Q3.pdf`)}"`)
  })
  it('a body that is not JSON is recorded as a byte count only', async () => {
    const { f, bucket } = rig(() => new Response('<html>CANARYhtmlBODY error page</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    await drain(await f(`${G}/profile`))
    const [one] = recorded(bucket)
    expect(one!.rec.response.body).toEqual({ non_json: true, bytes: 38 })
    expect(allBytes(bucket)).not.toContain('CANARYhtmlBODY')
  })
  it('request headers are never recorded, and the response keeps Content-Type and Retry-After only', async () => {
    const { f, bucket } = rig(() => jsonRes({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'slow down' } }, 429, { 'retry-after': '7', 'set-cookie': 'sid=CANARYcookie', 'x-guploader-uploadid': 'CANARYupload' }))
    await drain(await f(`${G}/profile`, { headers: { authorization: 'Bearer CANARYbearer', 'x-goog-api-key': 'CANARYkey' } }))
    const [one] = recorded(bucket)
    expect(one!.rec.response.headers).toEqual({ 'content-type': 'application/json; charset=UTF-8', 'retry-after': '7' })
    expect(allBytes(bucket)).not.toMatch(/CANARY/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('shapes survive', () => {
  it('an empty messages page keeps its omissions (no `messages`, no `nextPageToken`) and its number', async () => {
    const { f, bucket } = rig(() => jsonRes({ resultSizeEstimate: 0 }))
    await drain(await f(`${G}/messages?q=after%3A2026%2F10%2F07&maxResults=25`))
    const [one] = recorded(bucket)
    expect(one!.rec.kind).toBe('messages_list')
    expect(one!.rec.response.body).toEqual({ resultSizeEstimate: 0 })
    expect(one!.rec.request.query).toEqual([['q', 'after:2026/10/07'], ['maxResults', '25']])
  })
  it('an empty history page keeps its omission (no `history`) and its pseudonymised historyId', async () => {
    const { f, bucket } = rig(() => jsonRes({ historyId: '918273' }))
    await drain(await f(`${G}/history?startHistoryId=918000&maxResults=100&historyTypes=messageAdded`))
    const [one] = recorded(bucket)
    const body = one!.rec.response.body as Record<string, string>
    expect(Object.keys(body)).toEqual(['historyId'])
    expect(body.historyId).toMatch(/^\d{6}$/)
    expect(body.historyId).not.toBe('918273')
    expect(one!.rec.request.query.map((q) => q[0])).toEqual(['startHistoryId', 'maxResults', 'historyTypes'])
    expect(one!.rec.request.query[2]).toEqual(['historyTypes', 'messageAdded'])
    expect(one!.rec.request.query[0]![1]).not.toBe('918000')
  })
  it('ids are pseudonyms of the same length and class, consistent within a run: a history record\'s message id equals the later messages.get path id, yet differs from the original', async () => {
    const { f, bucket } = rig((url) =>
      url.includes('/history') ? jsonRes({ history: [{ id: '5001', messagesAdded: [{ message: { id: '18c3f9aB02', threadId: '18c3f9aB02', labelIds: ['INBOX', 'UNREAD', 'Label_17'] } }] }], nextPageToken: 'tok-AbC_123', historyId: '5002' }) : jsonRes({ id: '18c3f9aB02', threadId: '18c3f9aB02', labelIds: ['INBOX'] }),
    )
    await drain(await f(`${G}/history?startHistoryId=5000`))
    await drain(await f(`${G}/messages/18c3f9aB02?format=full`))
    const [hist, get] = recorded(bucket).sort((a, b) => a.key.localeCompare(b.key))
    const h = hist!.rec.response.body as { history: Array<{ id: string; messagesAdded: Array<{ message: { id: string; threadId: string; labelIds: string[] } }> }>; nextPageToken: string }
    const m = h.history[0]!.messagesAdded[0]!.message
    expect(m.id).toMatch(/^\d{2}[a-z]\d[a-z]\d[a-z][A-Z]\d{2}$/)
    expect(m.id).not.toBe('18c3f9aB02')
    expect(m.threadId).toBe(m.id) // the same original gives the same pseudonym
    expect(m.labelIds).toEqual(['INBOX', 'UNREAD', 'Label_17'])
    expect(h.nextPageToken).toMatch(/^[a-z]{3}-[A-Z][a-z][A-Z]_\d{3}$/)
    expect(get!.rec.request.path).toBe(`/gmail/v1/users/me/messages/${m.id}`)
    expect((get!.rec.response.body as { id: string }).id).toBe(m.id)
    expect(h.history[0]!.id).toMatch(/^\d{4}$/)
    expect(hist!.rec.request.query[0]![1]).not.toBe('5000')
  })
  it('numbers, booleans, null, key order and array lengths are kept; send-as keeps its flags and the enum the parser reads', async () => {
    const { f, bucket } = rig(() => jsonRes({ sendAs: [{ sendAsEmail: 'owner@vault.test', displayName: 'The Owner', isPrimary: true, verificationStatus: 'accepted', treatAsAlias: false, replyToAddress: null, n: 3 }, { sendAsEmail: 'alias@vault.test', verificationStatus: 'pending' }] }))
    await drain(await f(`${G}/settings/sendAs`))
    const body = recorded(bucket)[0]!.rec.response.body as { sendAs: Array<Record<string, unknown>> }
    expect(body.sendAs).toHaveLength(2)
    expect(Object.keys(body.sendAs[0]!)).toEqual(['sendAsEmail', 'displayName', 'isPrimary', 'verificationStatus', 'treatAsAlias', 'replyToAddress', 'n'])
    expect(body.sendAs[0]).toMatchObject({ sendAsEmail: 'xxxxx@xxxxx.xxxx', displayName: 'Xxx Xxxxx', isPrimary: true, verificationStatus: 'accepted', treatAsAlias: false, replyToAddress: null, n: 3 })
  })
  it('the base64 summary: length, padding, alphabet and the decoded byte count equal the input\'s', async () => {
    for (const bytes of [Uint8Array.from([1, 2, 3, 4, 5, 6]), Uint8Array.from([250, 251, 252, 253, 254]), Uint8Array.from([9, 8, 7, 6]), new Uint8Array(0), Uint8Array.from({ length: 100_000 }, (_, i) => i % 256)]) {
      const padded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
      for (const data of [padded, padded.replace(/=+$/, '')]) {
        const { f, bucket } = rig(() => jsonRes({ id: 'a', raw: data }))
        await drain(await f(`${G}/messages/a?format=raw`))
        const s = (recorded(bucket)[0]!.rec.response.body as { raw: { length: number; padding: number; alphabet_ok: boolean; decoded_bytes: number } }).raw
        expect(s).toEqual({ length: data.length, padding: data.length - data.replace(/=+$/, '').length, alphabet_ok: true, decoded_bytes: bytes.length })
      }
    }
  })
  it('a member that is not base64url is flagged by alphabet_ok, still never content', async () => {
    const { f, bucket } = rig(() => jsonRes({ raw: 'abc+def/gh==' }))
    await drain(await f(`${G}/messages/a?format=raw`))
    expect(recorded(bucket)[0]!.rec.response.body).toEqual({ raw: { length: 12, padding: 2, alphabet_ok: false, decoded_bytes: 7 } })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('behaviour unchanged', () => {
  it('every consumer gets byte-identical bodies, status and headers, including chunked streams and binary bytes', async () => {
    const payload = JSON.stringify({ raw: b64url(Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256)), id: 'm', note: 'é ü 日本語' })
    const bytes = enc.encode(payload)
    const chunks: Uint8Array[] = []
    for (let at = 0, n = 1; at < bytes.length; at += n, n = 1 + ((n * 37) % 4099)) chunks.push(bytes.subarray(at, at + n))
    const source = () => new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(ch.slice()); c.close() } })
    const direct = await new Response(source(), { status: 200, headers: { 'content-type': 'application/json', 'x-extra': '1' } }).arrayBuffer()
    const { f } = rig(() => new Response(source(), { status: 200, headers: { 'content-type': 'application/json', 'x-extra': '1' } }))
    const res = await f(`${G}/messages/m?format=raw`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-extra')).toBe('1')
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(direct))).toBe(true)
  })
  it('non-2xx answers keep status, statusText and body', async () => {
    const { f } = rig(() => new Response('{"error":{"code":404,"status":"NOT_FOUND"}}', { status: 404, statusText: 'Not Found', headers: { 'retry-after': '3' } }))
    const res = await f(`${G}/history?startHistoryId=1`)
    expect([res.status, res.statusText, res.headers.get('retry-after'), await res.text()]).toEqual([404, 'Not Found', '3', '{"error":{"code":404,"status":"NOT_FOUND"}}'])
  })
  it('the request reaches the plain fetch untouched (url, method, headers, body)', async () => {
    const { f, seen } = rig(() => jsonRes({}))
    await drain(await f(`${G}/profile`, { method: 'GET', headers: { authorization: 'Bearer abc' } }))
    await drain(await f(TOKEN_URL, { method: 'POST', body: 'grant_type=refresh_token&refresh_token=r' }))
    expect(seen[0]).toEqual({ url: `${G}/profile`, init: { method: 'GET', headers: { authorization: 'Bearer abc' } } })
    expect(seen[1]!.init).toEqual({ method: 'POST', body: 'grant_type=refresh_token&refresh_token=r' })
  })
  it('a streamed body is passed through, not buffered: the consumer reads its first chunk before the source has ended', async () => {
    let releaseSource!: () => void
    const gate = new Promise<void>((r) => (releaseSource = r))
    let sourceEnded = false
    const source = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode('{"raw":"AAAA'))
        await gate
        c.enqueue(enc.encode('AAAA"}'))
        sourceEnded = true
        c.close()
      },
    })
    const { f, bucket } = rig(() => new Response(source, { headers: { 'content-type': 'application/json' } }))
    const res = await f(`${G}/messages/m?format=raw`)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(dec.decode(first.value)).toBe('{"raw":"AAAA')
    expect(sourceEnded).toBe(false)
    expect(bucket.calls).toEqual([]) // nothing is written before the body has ended
    releaseSource()
    let rest = ''
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      rest += dec.decode(r.value)
    }
    expect(rest).toBe('AAAA"}')
    expect((recorded(bucket)[0]!.rec.response.body as { raw: { length: number } }).raw.length).toBe(8)
  })
})

describe('recording failure is harmless', () => {
  it('an R2 put that rejects leaves the call\'s result unchanged and logs the error name only', async () => {
    const bucket = fakeR2Bucket()
    bucket.put = async () => {
      throw Object.assign(new Error('R2 said CANARYr2message'), { name: 'R2Error' })
    }
    const log: string[] = []
    const { f } = rig(() => jsonRes({ emailAddress: 'a@b.test', historyId: '5' }), { bucket, log })
    const res = await f(`${G}/profile`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ emailAddress: 'a@b.test', historyId: '5' })
    expect(log.some((l) => l.includes('write failed') && l.includes('R2Error'))).toBe(true)
    expect(log.join('\n')).not.toContain('CANARY')
  })
  it('an unreadable index does not stop recording', async () => {
    const bucket = fakeR2Bucket()
    const real = bucket.get.bind(bucket)
    bucket.get = async (k: string) => {
      if (k === RECORDINGS_INDEX_KEY) throw new Error('boom')
      return real(k)
    }
    const { f } = rig(() => jsonRes({ emailAddress: 'a@b.test', historyId: '5' }), { bucket })
    await drain(await f(`${G}/profile`))
    expect(recorded(bucket)).toHaveLength(1)
  })
})

describe('the index is never overwritten from a failed read, and never hangs a call (D81 a, e)', () => {
  const profile = () => jsonRes({ emailAddress: 'a@b.test', historyId: '5' })
  afterEach(() => vi.useRealTimers())
  const indexKeys = (bucket: FakeR2Bucket): string[] => (JSON.parse(dec.decode(bucket.objects.get(RECORDINGS_INDEX_KEY)!)) as { objects: Array<{ key: string }> }).objects.map((o) => o.key)

  it('a transient GET error on the index skips the index write: the earlier entries stay listed', async () => {
    const log: string[] = []
    const { f, bucket } = rig(profile, { log })
    await drain(await f(`${G}/profile`))
    const first = indexKeys(bucket)
    expect(first).toHaveLength(1)
    const real = bucket.get.bind(bucket)
    bucket.get = async (k: string) => {
      if (k === RECORDINGS_INDEX_KEY) throw Object.assign(new Error('r2 hiccup CANARYidx'), { name: 'R2Error' })
      return real(k)
    }
    await drain(await f(`${G}/profile`))
    expect(recorded(bucket)).toHaveLength(2) // the object itself was written
    expect(indexKeys(bucket)).toEqual(first) // the index was not rewritten without it
    expect(log.some((l) => l.includes('index') && l.includes('R2Error'))).toBe(true)
    expect(log.join('\n')).not.toContain('CANARY')
  })
  it('an unparsable index is left as it is, not replaced', async () => {
    const { f, bucket } = rig(profile)
    await drain(await f(`${G}/profile`))
    bucket.objects.set(RECORDINGS_INDEX_KEY, enc.encode('not json {'))
    await drain(await f(`${G}/profile`))
    expect(dec.decode(bucket.objects.get(RECORDINGS_INDEX_KEY)!)).toBe('not json {')
  })
  it('an absent index is an empty one: the first write creates it', async () => {
    const { f, bucket } = rig(profile)
    expect(bucket.objects.has(RECORDINGS_INDEX_KEY)).toBe(false)
    await drain(await f(`${G}/profile`))
    expect(indexKeys(bucket)).toHaveLength(1)
  })
  it('an index GET that never resolves does not hang the call: it returns its body unchanged after the timeout', async () => {
    vi.useFakeTimers()
    const log: string[] = []
    const { f, bucket } = rig(profile, { log })
    bucket.get = () => new Promise(() => {})
    const pending = f(`${G}/profile`)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000) // the index read in load() times out: the response is handed over
    const res = await pending
    const body = res.json() // the stream closes after the write's own bounded index access
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await body).toEqual({ emailAddress: 'a@b.test', historyId: '5' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(log.some((l) => l.includes('index'))).toBe(true)
  })
})

describe('caps (D78, CORE129 D10a)', () => {
  it('at most 3 recordings per kind, counted on a kind other than the first implemented', async () => {
    const { f, bucket } = rig(() => jsonRes({ resultSizeEstimate: 0 }))
    for (let i = 0; i < 6; i++) await drain(await f(`${G}/messages?q=x&maxResults=25`))
    for (let i = 0; i < 2; i++) await drain(await f(`${G}/profile`))
    const kinds = recorded(bucket).map((r) => r.rec.kind)
    expect(kinds.filter((k) => k === 'messages_list')).toHaveLength(RECORDING_CAP)
    expect(kinds.filter((k) => k === 'profile')).toHaveLength(2)
  })
  it('the non-2xx allowance is separate: 3 successes do not use the 3 per distinct error status', async () => {
    let n = 0
    const { f, bucket } = rig(() => (n++ < 3 ? jsonRes({ id: 'a' }) : jsonRes({ error: { code: n < 8 ? 404 : 429, status: 'X' } }, n < 8 ? 404 : 429)))
    for (let i = 0; i < 12; i++) await drain(await f(`${G}/messages/a?format=full`))
    const statuses = recorded(bucket).map((r) => r.rec.response.status).sort()
    expect(statuses).toEqual([200, 200, 200, 404, 404, 404, 429, 429, 429])
  })
  it('the cap holds across recorders of one run (an isolate restart): counts are seeded from the index', async () => {
    const bucket = fakeR2Bucket()
    const make = () => createRecordingFetch({ plain: (async () => jsonRes({ emailAddress: 'a@b.test', historyId: '5' })) as typeof fetch, bucket, run: { id: 'same', start: NOW }, clock: () => NOW, until: new Date(NOW.getTime() + 1000), random: counter(), log: () => {} })
    for (let i = 0; i < 2; i++) await drain(await make()(`${G}/profile`))
    for (let i = 0; i < 2; i++) await drain(await make()(`${G}/profile`))
    expect(recorded(bucket)).toHaveLength(RECORDING_CAP)
  })
  it('another run has its own allowance, under its own prefix, and the index lists every object', async () => {
    const bucket = fakeR2Bucket()
    const make = (id: string) => createRecordingFetch({ plain: (async () => jsonRes({ emailAddress: 'a@b.test', historyId: '5' })) as typeof fetch, bucket, run: { id, start: NOW }, clock: () => NOW, until: new Date(NOW.getTime() + 1000), random: counter(), log: () => {} })
    for (const id of ['inst-a', 'inst-b']) for (let i = 0; i < 4; i++) await drain(await make(id)(`${G}/profile`))
    const keys = recorded(bucket).map((r) => r.key)
    expect(keys).toHaveLength(6)
    expect(keys.every((k) => /^_recordings\/20261106T100000Z-inst-[ab]\/\d{3}-profile-200-[0-9a-f]{6}\.json$/.test(k))).toBe(true)
    const index = JSON.parse(dec.decode(bucket.objects.get(RECORDINGS_INDEX_KEY)!)) as { version: number; objects: Array<{ key: string; kind: string; status: number }> }
    expect(index.objects.map((o) => o.key).sort()).toEqual([...keys].sort())
    expect(index.objects[0]).toMatchObject({ kind: 'profile', status: 200 })
  })
})
