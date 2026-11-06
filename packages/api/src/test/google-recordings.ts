// Test-only ([[CHN5]] D80, [[CHN153]]). The SYNTHETIC recordings: exchanges written to Google's documented wire shapes (D72), one per call kind the vault makes,
// each passed through the recorder itself (so the file is exactly what a real exchange would have produced) and stored with the expectation of its replay.
// `pnpm -C packages/api recordings:generate` rewrites `fixtures/google/*.json`; a test checks the committed files equal this output. Real recordings join
// them later as `source: recorded` files, with no change here. Web APIs only.
import { createRecordingFetch, type RecordedExchange } from '../channels/gmail/recorder.js'
import { fakeR2Bucket } from './objects.js'
import type { RecordingFixture } from './recording-replay.js'

/** Google's base64url members (raw, part `data`, attachment `data`) are padded with `=` ([[CHN5]] D82 d). A JWT's segments are not: `jwtPart`. */
const b64url = (s: string | Uint8Array): string => btoa(typeof s === 'string' ? s : String.fromCharCode(...s)).replace(/\+/g, '-').replace(/\//g, '_')
const jwtPart = (s: string): string => b64url(s).replace(/=+$/, '')
const G = 'https://gmail.googleapis.com/gmail/v1/users/me'
const T = 'https://oauth2.googleapis.com/token'
const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
const jwt = (claims: object): string => `${jwtPart('{"alg":"RS256","kid":"synthetic-1","typ":"JWT"}')}.${jwtPart(JSON.stringify(claims))}.${jwtPart('synthetic-signature')}`
const form = (o: Record<string, string>): string => new URLSearchParams(o).toString()
const PDF = b64url(Uint8Array.from({ length: 1500 }, (_, i) => (i * 13) % 256))
const RAW = b64url(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 256))

interface Synthetic {
  name: string
  url: string
  init?: RequestInit
  respond: () => Response
  expect: RecordingFixture['expect']
}

const MESSAGE_FULL = {
  id: '18c3f9ab02d4e7a1',
  threadId: '18c3f9ab02d4e7a1',
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  snippet: 'Hello Owner, the report is attached.',
  historyId: '2101873',
  internalDate: '1791279600000',
  sizeEstimate: 6481,
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: '',
    headers: [
      { name: 'Delivered-To', value: 'owner@vault.test' },
      { name: 'From', value: 'Jane Roe <jane@acme.test>' },
      { name: 'To', value: 'Owner <owner@vault.test>' },
      { name: 'Subject', value: '=?UTF-8?B?UXVhcnRlcmx5IHJlcG9ydCDinJM=?=' },
      { name: 'Date', value: 'Thu, 22 Oct 2026 09:00:00 +0000' },
      { name: 'Message-ID', value: '<CAF1234abcd@mail.acme.test>' },
      { name: 'Content-Type', value: 'multipart/mixed; boundary="000000000000a1b2c3"' },
    ],
    body: { size: 0 },
    parts: [
      { partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }, { name: 'Content-Transfer-Encoding', value: 'quoted-printable' }], body: { size: 36, data: b64url('Hello Owner, the report is attached.') } },
      { partId: '1', mimeType: 'application/pdf', filename: 'report.pdf', headers: [{ name: 'Content-Type', value: 'application/pdf; name="report.pdf"' }, { name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }, { name: 'Content-Transfer-Encoding', value: 'base64' }], body: { attachmentId: 'ANGjdJ_attachmentId01', size: 1500 } },
    ],
  },
}

/** The per-minute quota `403` as Google sent it on the real run ([[CHN5]] D82 g), values made up: the same key paths, no `Retry-After`. */
const QUOTA_MESSAGE = "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:123456789012'."
const QUOTA_403 = {
  error: {
    code: 403,
    message: QUOTA_MESSAGE,
    errors: [{ message: QUOTA_MESSAGE, domain: 'usageLimits', reason: 'rateLimitExceeded' }],
    status: 'PERMISSION_DENIED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com', metadata: { consumer: 'projects/123456789012', quota_limit_value: '1500', quota_unit: '1/min/{project}/{user}', quota_metric: 'gmail.googleapis.com/quota_total_query_cost', window_start_time: '1791363743', quota_location: 'global', service: 'gmail.googleapis.com', quota_limit: 'TotalQueryCostPerMinutePerUser' } },
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Request a higher quota limit.', url: 'https://cloud.google.com/docs/quota#requesting_higher_quota' }] },
    ],
  },
}

export const SYNTHETIC: Synthetic[] = [
  { name: 'token-refresh-ok', url: T, init: { method: 'POST', body: form({ grant_type: 'refresh_token', refresh_token: 'synthetic-refresh', client_id: 'synthetic.apps.test', client_secret: 'synthetic-secret' }) }, respond: json({ access_token: 'ya29.synthetic-access', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email', token_type: 'Bearer', id_token: jwt({ iss: 'https://accounts.google.com', azp: 'synthetic.apps.test', aud: 'synthetic.apps.test', sub: '1', hd: 'vault.test', email: 'owner@vault.test', email_verified: true, at_hash: 'abc', name: 'Owner', given_name: 'Owner', family_name: 'Test', iat: 1791279600, exp: 1791283200 }) }), expect: { result: { access_token: true, rotated: false } } },
  { name: 'token-refresh-rotated', url: T, init: { method: 'POST', body: form({ grant_type: 'refresh_token', refresh_token: 'synthetic-refresh', client_id: 'synthetic.apps.test', client_secret: 'synthetic-secret' }) }, respond: json({ access_token: 'ya29.synthetic-access', refresh_token: 'synthetic-refresh-new', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' }), expect: { result: { access_token: true, rotated: true } } },
  { name: 'token-refresh-invalid-grant', url: T, init: { method: 'POST', body: form({ grant_type: 'refresh_token', refresh_token: 'synthetic-refresh', client_id: 'synthetic.apps.test', client_secret: 'synthetic-secret' }) }, respond: json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400), expect: { error: { type: 'GoogleRefreshError', code: 'invalid_grant' } } },
  { name: 'token-exchange-ok', url: T, init: { method: 'POST', body: form({ grant_type: 'authorization_code', code: '4/0Asynthetic-code', client_id: 'synthetic.apps.test', client_secret: 'synthetic-secret', redirect_uri: 'https://api.test/oauth/google/callback', code_verifier: 'synthetic-verifier' }) }, respond: json({ access_token: 'ya29.synthetic-access', refresh_token: '1//synthetic-refresh', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', token_type: 'Bearer', id_token: jwt({ iss: 'https://accounts.google.com', azp: 'synthetic.apps.test', aud: 'synthetic.apps.test', sub: '110169484474386276334', email: 'owner@vault.test', email_verified: true, at_hash: 'abc', iat: 1791279600, exp: 1791283200 }) }), expect: { result: { scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], has_refresh_token: true, has_id_token: true } } },
  { name: 'profile', url: `${G}/profile`, respond: json({ emailAddress: 'owner@vault.test', messagesTotal: 4821, threadsTotal: 3102, historyId: '2101873' }), expect: { result: { emailAddress: 'xxxxx@xxxxx.xxxx', historyId: '$string', messagesTotal: 4821, threadsTotal: 3102 } } },
  { name: 'send-as', url: `${G}/settings/sendAs`, respond: json({ sendAs: [{ sendAsEmail: 'owner@vault.test', displayName: 'Owner', replyToAddress: '', signature: '', isPrimary: true, isDefault: true, treatAsAlias: false }, { sendAsEmail: 'billing@vault.test', displayName: 'Billing', isDefault: false, treatAsAlias: true, verificationStatus: 'accepted' }, { sendAsEmail: 'old@vault.test', verificationStatus: 'pending' }] }), expect: { result: [{ isPrimary: true }, { verificationStatus: 'accepted' }, { verificationStatus: 'pending' }] } },
  { name: 'history-list', url: `${G}/history?startHistoryId=2101000&maxResults=100&historyTypes=messageAdded`, respond: json({ history: [{ id: '2101500', messages: [{ id: '18c3f9ab02d4e7a1', threadId: '18c3f9ab02d4e7a1' }], messagesAdded: [{ message: { id: '18c3f9ab02d4e7a1', threadId: '18c3f9ab02d4e7a1', labelIds: ['INBOX', 'UNREAD'] } }] }, { id: '2101600', messages: [{ id: '18c3f9ab02d4e7b2', threadId: '18c3f9ab02d4e7a1' }], labelsAdded: [{ message: { id: '18c3f9ab02d4e7b2', threadId: '18c3f9ab02d4e7a1' }, labelIds: ['STARRED'] }] }], nextPageToken: '09876543210123456789', historyId: '2101873' }), expect: { result: { history: [{ messagesAdded: [{ message: { labelIds: ['INBOX', 'UNREAD'] } }] }, { messagesAdded: [] }], nextPageToken: '$string' } } },
  { name: 'history-list-empty', url: `${G}/history?startHistoryId=2101873&maxResults=100&historyTypes=messageAdded`, respond: json({ historyId: '2101873' }), expect: { result: { history: [], nextPageToken: null, historyId: '$string' } } },
  { name: 'history-list-404', url: `${G}/history?startHistoryId=17&maxResults=100&historyTypes=messageAdded`, respond: json({ error: { code: 404, message: 'Requested entity was not found.', errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }], status: 'NOT_FOUND' } }, 404), expect: { error: { type: 'GmailApiError', status: 404, gmailStatus: 'NOT_FOUND', reason: 'notFound' } } },
  { name: 'messages-list', url: `${G}/messages?q=after%3A2026%2F10%2F07&maxResults=25`, respond: json({ messages: [{ id: '18c3f9ab02d4e7a1', threadId: '18c3f9ab02d4e7a1' }, { id: '18c3f9ab02d4e7b2', threadId: '18c3f9ab02d4e7a1' }], nextPageToken: '16543210987654321012', resultSizeEstimate: 201 }), expect: { result: { messages: [{ id: '$string' }, { id: '$string' }], nextPageToken: '$string' } } },
  { name: 'messages-list-empty', url: `${G}/messages?q=after%3A2026%2F10%2F07&maxResults=25`, respond: json({ resultSizeEstimate: 0 }), expect: { result: { messages: [], nextPageToken: null } } },
  { name: 'message-full', url: `${G}/messages/18c3f9ab02d4e7a1?format=full`, respond: json(MESSAGE_FULL), expect: { result: { mapped: true, attachments: 1 } } },
  { name: 'message-raw', url: `${G}/messages/18c3f9ab02d4e7a1?format=raw`, respond: json({ id: '18c3f9ab02d4e7a1', threadId: '18c3f9ab02d4e7a1', labelIds: ['INBOX', 'UNREAD'], sizeEstimate: 6481, snippet: 'Hello Owner, the report is attached.', raw: RAW, historyId: '2101873', internalDate: '1791279600000' }), expect: { result: { raw_length: RAW.length, decoded_bytes: 4096 } } },
  { name: 'attachment', url: `${G}/messages/18c3f9ab02d4e7a1/attachments/ANGjdJ_attachmentId01`, respond: json({ size: 1500, data: PDF }), expect: { result: { data_length: PDF.length, decoded_bytes: 1500 } } },
  {
    name: 'messages-list-403',
    url: `${G}/messages?q=after%3A1791363743%20%7Bin%3Ainbox%20in%3Asent%7D&maxResults=25&pageToken=16543210987654321012`,
    respond: json(QUOTA_403, 403),
    expect: { error: { type: 'GmailApiError', status: 403, gmailStatus: 'PERMISSION_DENIED', reason: 'rateLimitExceeded', retryAfterSeconds: null } },
  },
  { name: 'message-full-404', url: `${G}/messages/18c3f9ab02d4e7a1?format=full`, respond: json({ error: { code: 404, message: 'Requested entity was not found.', errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }], status: 'NOT_FOUND' } }, 404), expect: { result: { skip: 'not_found' } } },
]

/** Deterministic pseudonyms: the fixtures are reproducible. */
const seeded = (): ((n: number) => Uint8Array) => {
  let c = 11
  return (n) => Uint8Array.from({ length: n }, () => (c = (c * 37 + 19) % 251))
}

/** Passes one synthetic exchange through a fresh recorder and returns the single file it wrote. */
export async function recordSynthetic(s: Synthetic): Promise<RecordingFixture> {
  const bucket = fakeR2Bucket()
  const f = createRecordingFetch({ plain: (async () => s.respond()) as typeof fetch, bucket, run: { id: s.name, start: new Date('2026-11-06T10:00:00Z') }, clock: () => new Date('2026-11-06T10:00:00Z'), until: new Date('2026-11-07T10:00:00Z'), random: seeded(), log: () => {} })
  await (await f(s.url, s.init)).arrayBuffer()
  const [key] = [...bucket.objects.keys()].filter((k) => k !== '_recordings/index.json')
  const recording = JSON.parse(new TextDecoder().decode(bucket.objects.get(key!)!)) as RecordedExchange
  return { name: s.name, recording: { ...recording, source: 'synthetic' }, expect: s.expect }
}
export const buildSyntheticRecordings = (): Promise<RecordingFixture[]> => Promise.all(SYNTHETIC.map(recordSynthetic))
