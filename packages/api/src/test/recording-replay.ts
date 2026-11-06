// Test-only ([[CHN5]] D80, [[CHN153]]). Replays one recording file through the REAL code that reads Google's answers: `refreshAccessToken`, `exchangeCode`,
// `HttpGmailClient`, `GmailChannel` and the mapper. The recording is rebuilt to Google's wire form (base64 summaries become filler of that size, an id_token
// summary becomes an unsigned token), served by an injected `fetch`, and what the code read is returned in a small normalised shape for the file's `expect`.
// Adding a recording needs a file and its expectation, no code here. Web APIs only.
import { GOOGLE_ENDPOINTS, GoogleExchangeError, GoogleRefreshError, exchangeCode, refreshAccessToken } from '../connections/google.js'
import { GmailApiError, HttpGmailClient } from '../channels/gmail/client.js'
import { GmailChannel } from '../channels/gmail/channel.js'
import { base64UrlMemberDecoder } from '../channels/gmail/decoder.js'
import type { RecordedExchange } from '../channels/gmail/recorder.js'

/** One file of `src/test/fixtures/google/`: a recording and what replaying it must read. */
export interface RecordingFixture {
  name: string
  recording: RecordedExchange
  /** `result` is matched with `toMatchObject` against what the replay read; `error` against the failure it threw. */
  expect: { result?: unknown; error?: unknown }
}

const b64url = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
const isB64Summary = (v: Json): v is { length: number; padding: number; alphabet_ok: boolean; decoded_bytes: number } =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.length === 'number' && typeof v.padding === 'number' && typeof v.decoded_bytes === 'number' && 'alphabet_ok' in v

/** A recorded body to its wire JSON: a summary under `raw`/`data` becomes filler of the recorded length, an `id_token` summary an unsigned JWT. */
export function expandBody(v: Json, path: string[] = []): Json {
  if (Array.isArray(v)) return v.map((e) => expandBody(e, path))
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => {
        if ((k === 'raw' || k === 'data') && isB64Summary(val)) return [k, 'A'.repeat(val.length - val.padding) + '='.repeat(val.padding)]
        if (path.length === 0 && k === 'id_token' && val !== null && typeof val === 'object' && !Array.isArray(val) && 'claims' in val) {
          const s = val as { alg: string; claims: Record<string, string>; iss?: string; email_verified?: boolean }
          const sample: Record<string, Json> = { string: 'x', number: 1, boolean: true, null: null, object: {}, array: [] }
          const claims = Object.fromEntries(Object.entries(s.claims).map(([c, t]) => [c, c === 'iss' && s.iss ? s.iss : c === 'email_verified' && s.email_verified !== undefined ? s.email_verified : (sample[t] ?? 'x')]))
          return [k, `${b64url(JSON.stringify({ alg: s.alg, typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('signature')}`]
        }
        return [k, expandBody(val, [...path, k])]
      }),
    )
  }
  return v
}

/** The recording as Google sent it. */
export function wireResponse(rec: RecordedExchange): Response {
  const body = rec.response.body
  const nonJson = body as { non_json?: true; bytes?: number } | null
  const text = body === null ? '' : nonJson?.non_json === true ? 'x'.repeat(nonJson.bytes ?? 0) : JSON.stringify(expandBody(body as Json))
  return new Response(text, { status: rec.response.status, headers: rec.response.headers })
}

const idOf = (rec: RecordedExchange): string => rec.request.path.split('/').filter(Boolean)[5] ?? 'm'
const attachmentIdOf = (rec: RecordedExchange): string => rec.request.path.split('/').filter(Boolean)[7] ?? 'a'
const bytesOf = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> => new Uint8Array(await new Response(s).arrayBuffer())

/** Replays a fixture; returns what the code read (`{ result }`) or what it threw (`{ error }`). */
export async function replay(fx: RecordingFixture): Promise<{ result: unknown } | { error: unknown }> {
  const rec = fx.recording
  const served: typeof fetch = async () => wireResponse(rec)
  const client = new HttpGmailClient({ accessToken: async () => 'replay-token', fetch: served })
  const conn = { id: 'conn-replay', mailbox: 'owner@vault.test' }
  try {
    switch (rec.kind) {
      case 'token_refresh': {
        const t = await refreshAccessToken({ endpoints: GOOGLE_ENDPOINTS, clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch: served })
        return { result: { access_token: typeof t.accessToken === 'string' && t.accessToken !== '', rotated: t.refreshToken !== null } }
      }
      case 'token_exchange': {
        const t = await exchangeCode({ endpoints: GOOGLE_ENDPOINTS, clientId: 'c', clientSecret: 's', redirectUri: 'https://w.test/cb', code: 'x', verifier: 'v', fetch: served })
        return { result: { scopes: t.scopes, has_refresh_token: t.refreshToken !== '', has_id_token: t.idToken.split('.').length === 3 } }
      }
      case 'profile':
        return { result: await client.getProfile() }
      case 'watch': {
        const w = await client.watch({ topicName: 'projects/p/topics/t' })
        return { result: { historyId: w.historyId, expiration: w.expiration } }
      }
      case 'stop':
        await client.stop()
        return { result: { stopped: true } }
      case 'send_as':
        return { result: await client.listSendAs() }
      case 'history_list':
        return { result: await client.listHistory({ startHistoryId: '1', maxResults: 100, historyTypes: ['messageAdded'] }) }
      case 'messages_list':
        return { result: await client.listMessages({ q: 'after:2026/10/07', maxResults: 25 }) }
      case 'message_full': {
        const out = await new GmailChannel(client).readMessage(conn, idOf(rec))
        if ('skip' in out) return { result: { skip: out.skip } }
        return { result: { mapped: true, attachments: out.message.attachments.length, provider_message_id: out.facts.provider_message_id, participants: out.facts.participants.map((p) => ({ role: p.role, named: p.name !== undefined })) } }
      }
      case 'message_raw': {
        const wire = await client.getMessageRaw(idOf(rec))
        const text = await new Response(wire).text()
        const raw = (JSON.parse(text) as { raw?: string }).raw ?? ''
        const decoded = await bytesOf(new Response(text).body!.pipeThrough(base64UrlMemberDecoder('raw')))
        return { result: { raw_length: raw.length, decoded_bytes: decoded.byteLength } }
      }
      case 'attachment_get': {
        const text = await new Response(await client.getAttachment(idOf(rec), attachmentIdOf(rec))).text()
        const data = (JSON.parse(text) as { data?: string }).data ?? ''
        const decoded = await bytesOf(new Response(text).body!.pipeThrough(base64UrlMemberDecoder('data')))
        return { result: { data_length: data.length, decoded_bytes: decoded.byteLength } }
      }
      default:
        throw new Error(`replay has no reader for kind ${rec.kind}`)
    }
  } catch (err) {
    if (err instanceof GmailApiError) return { error: { type: 'GmailApiError', status: err.status, gmailStatus: err.gmailStatus, reason: err.reason, retryAfterSeconds: err.retryAfterSeconds } }
    if (err instanceof GoogleRefreshError || err instanceof GoogleExchangeError) return { error: { type: err.name, code: err.code } }
    throw err
  }
}
