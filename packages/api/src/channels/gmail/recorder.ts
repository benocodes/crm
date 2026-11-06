// The Google response recorder ([[CHN5]] D78, D79; cycle [[CHN153]]). An opt-in wrapper around the `fetch` the composition hands to Gmail code: it
// records a REDACTED copy of each exchange with `gmail.googleapis.com` and Google's token endpoint into the env's R2 bucket, so a user can pull the
// real shapes (D72) without any token, secret, header or message content leaving the Worker.
//
// Web APIs only (workerd runs it); no dependency. Redaction is deny-by-default (D79 rule 1): a JSON string is masked unless its key path is on the
// allow-list below, and the allow-list is the only place where a string value survives. The recorder never changes the Google call: the consumer gets
// byte-identical bodies (a streamed body is passed through a TransformStream, never buffered whole), and a failed R2 write is logged and swallowed.
import type { R2BucketLike } from '../../objects/store.js'

export const RECORDINGS_PREFIX = '_recordings/'
export const RECORDINGS_INDEX_KEY = `${RECORDINGS_PREFIX}index.json`
export const RECORDING_MAX_DAYS = 7
/** At most this many recordings per call kind per run, plus this many per distinct non-2xx status of a kind (D78). */
export const RECORDING_CAP = 3
const RECORDING_TIMEOUT_MS = 10_000
/** A body whose non-base64 text exceeds this is recorded as `non_json` with its byte count only. */
const SKELETON_LIMIT = 1_000_000

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The switch (D78)

export interface RecordingSwitch {
  /** The instant recording stops, or null when it is off. */
  until: Date | null
  /** The variable's problem, never its value: logged once at startup. */
  problem: 'malformed' | 'too_far' | null
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** `GOOGLE_RECORDING_UNTIL`: on only while `now` is before it and it is at most 7 days ahead. Absent or past: off, no problem. */
export function parseRecordingSwitch(raw: string | undefined, now: Date): RecordingSwitch {
  if (raw === undefined || raw.trim() === '') return { until: null, problem: null }
  const text = raw.trim()
  const at = ISO_UTC.test(text) ? Date.parse(text) : Number.NaN
  // A date that rolls over (February 30th) is not an instant: it must print back as what was written.
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 19) !== text.slice(0, 19)) return { until: null, problem: 'malformed' }
  if (at <= now.getTime()) return { until: null, problem: null }
  if (at - now.getTime() > RECORDING_MAX_DAYS * 86_400_000) return { until: null, problem: 'too_far' }
  return { until: new Date(at), problem: null }
}

export const recordingProblemNotice = (problem: 'malformed' | 'too_far'): string =>
  problem === 'malformed'
    ? '[recording] GOOGLE_RECORDING_UNTIL is not an ISO-8601 UTC instant: Google recording is off'
    : `[recording] GOOGLE_RECORDING_UNTIL is more than ${RECORDING_MAX_DAYS} days ahead: Google recording is off`

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Redaction (D79)

/** D79 rule 2: ASCII letters to `x`/`X`, digits to `0`, other ASCII kept (structure); any non-ASCII character is masked too (stricter than D79: it is content). */
export function maskText(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 128) out += ch >= 'a' && ch <= 'z' ? 'x' : ch >= 'A' && ch <= 'Z' ? 'X' : ch >= '0' && ch <= '9' ? '0' : ch
    else out += /\p{Lu}/u.test(ch) ? 'X' : /\p{N}/u.test(ch) ? '0' : 'x'
  }
  return out
}

const SAFE_CHARSET = /^(utf-8|us-ascii|iso-8859-\d{1,2}|windows-125\d|gb2312|gbk|gb18030|big5|koi8-[ru]|shift_jis|euc-jp|euc-kr|iso-2022-jp|utf-7)$/i
const WORD = /=\?([^?\s]{1,40})\?([BbQq])\?([^?\s]*)\?=/g

/** A header value, masked; an RFC 2047 encoded word keeps its frame (`=?charset?B|Q?` and `?=`, the charset only when it is a known one) and masks its text. */
export function maskHeaderValue(v: string): string {
  let out = ''
  let last = 0
  for (const m of v.matchAll(WORD)) {
    out += maskText(v.slice(last, m.index))
    const charset = SAFE_CHARSET.test(m[1]!) ? m[1]! : maskText(m[1]!)
    out += `=?${charset}?${m[2]}?${maskText(m[3]!)}?=`
    last = m.index + m[0].length
  }
  return out + maskText(v.slice(last))
}

/** `Content-Type`, `Content-Disposition`, `Content-Transfer-Encoding`: the media type and parameter names stay, parameter values are masked (D79 rule 6). */
function maskStructured(v: string): string {
  const [head = '', ...params] = v.split(';')
  const keptHead = /^\s*[A-Za-z0-9!#$&^_.+/-]{1,100}\s*$/.test(head) ? head : maskText(head)
  return [
    keptHead,
    ...params.map((p) => {
      const i = p.indexOf('=')
      if (i < 0) return maskText(p)
      const name = p.slice(0, i)
      const keptName = /^\s*[A-Za-z0-9*_.-]{1,40}\s*$/.test(name) ? name : maskText(name)
      return `${keptName}=${maskHeaderValue(p.slice(i + 1))}`
    }),
  ].join(';')
}
const STRUCTURED_HEADERS = new Set(['content-type', 'content-disposition', 'content-transfer-encoding'])

/** An error message that may echo content: any word with an `@` or a long opaque run is masked. */
function scrubMessage(s: string): string {
  return s
    .split(/(\s+)/)
    .map((w) => (w.includes('@') || (w.length >= 20 && /\d/.test(w)) ? maskText(w) : w))
    .join('')
}

/** A base64url member's summary (D79 rule 4): never content. `decoded_bytes` is what the member decodes to. */
export interface Base64Summary {
  length: number
  padding: number
  alphabet_ok: boolean
  decoded_bytes: number
}
const decodedBytes = (unpadded: number): number => Math.floor((unpadded * 6) / 8)
export function summarizeBase64(s: string): Base64Summary {
  const padding = /=*$/.exec(s)![0].length
  const body = s.slice(0, s.length - padding)
  const ok = /^[A-Za-z0-9_-]*$/.test(body) && body.length % 4 !== 1
  return { length: s.length, padding, alphabet_ok: ok, decoded_bytes: decodedBytes(body.length) }
}
const SENTINEL = '@@b64@@'

/** D79 rule 5: a pseudonym of the same length and character class, consistent within one run, kept in memory only. */
export class Pseudonyms {
  private readonly map = new Map<string, string>()
  private readonly used = new Set<string>()
  constructor(private readonly random: (n: number) => Uint8Array) {}
  of(original: string): string {
    const known = this.map.get(original)
    if (known !== undefined) return known
    let out = original
    for (let attempt = 0; attempt < 32; attempt++) {
      const bytes = this.random(original.length)
      let candidate = ''
      for (let i = 0; i < original.length; i++) {
        const ch = original[i]!
        const b = bytes[i]!
        candidate += ch >= '0' && ch <= '9' ? String(b % 10) : ch >= 'a' && ch <= 'z' ? String.fromCharCode(97 + (b % 26)) : ch >= 'A' && ch <= 'Z' ? String.fromCharCode(65 + (b % 26)) : /\P{ASCII}/u.test(ch) ? 'x' : ch
      }
      out = candidate
      if (candidate !== original && !this.used.has(candidate)) break
    }
    this.map.set(original, out)
    this.used.add(out)
    return out
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
const ID_KEYS = new Set(['id', 'threadId', 'historyId', 'nextPageToken', 'attachmentId'])
const TOKEN_MEMBERS = new Set(['access_token', 'refresh_token', 'code'])
/** Where a string value survives in the clear (D79 rule 6), by key path (array indexes omitted). The only such list: nothing else is ever written as is. */
const ALLOWED_PATHS: RegExp[] = [
  /^payload(\.parts)*\.(mimeType|partId)$/,
  /^sendAs\.verificationStatus$/, // a Google enum the parser reads ([[CHN153]] decision), not content
  /^(error|token_type|scope|error\.status)$/,
  /^error\.errors\.(reason|domain)$/,
]
const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

function b64urlDecode(s: string): string | null {
  try {
    const t = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/** D79 rule 3: an `id_token` keeps its header's `alg`, its claim names with JSON types, and the values of `iss` and `email_verified`. Unreadable: `<redacted>`. */
function idTokenSummary(token: string): Json {
  const parts = token.split('.')
  const header = parts[0] ? b64urlDecode(parts[0]) : null
  const claims = parts[1] ? b64urlDecode(parts[1]) : null
  try {
    const h = JSON.parse(header ?? '') as Record<string, unknown>
    const c = JSON.parse(claims ?? '') as Record<string, unknown>
    return {
      alg: typeof h.alg === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(h.alg) ? h.alg : '<redacted>',
      claims: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeName(v)])),
      ...(typeof c.iss === 'string' && /^[A-Za-z0-9.:/-]{1,100}$/.test(c.iss) ? { iss: c.iss } : {}),
      ...(typeof c.email_verified === 'boolean' ? { email_verified: c.email_verified } : {}),
    }
  } catch {
    return '<redacted>'
  }
}

interface RedactCtx {
  pseudo: Pseudonyms
}

function redactHeader(h: Json, ctx: RedactCtx, path: string[]): Json {
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return redactValue(h, path, ctx)
  const name = typeof h.name === 'string' ? h.name : null
  const out: { [k: string]: Json } = {}
  for (const [k, v] of Object.entries(h)) {
    if (k === 'name' && typeof v === 'string') out[k] = /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : maskText(v)
    else if (k === 'value' && typeof v === 'string') out[k] = name !== null && STRUCTURED_HEADERS.has(name.toLowerCase()) ? maskStructured(v) : maskHeaderValue(v)
    else out[k] = redactValue(v, [...path, k], ctx)
  }
  return out
}

function redactString(key: string, path: string[], v: string, ctx: RedactCtx): Json {
  if (path.length === 1 && TOKEN_MEMBERS.has(key)) return '<redacted>'
  if (path.length === 1 && key === 'id_token') return idTokenSummary(v)
  if ((key === 'raw' || key === 'data') && path.length >= 1) return { ...(v.startsWith(SENTINEL) ? parseSentinel(v) : summarizeBase64(v)) }
  if (ID_KEYS.has(key)) return ctx.pseudo.of(v)
  const full = path.join('.')
  if (key === 'labelIds' || ALLOWED_PATHS.some((re) => re.test(full))) return v
  if (full === 'error.message' || full === 'error_description') return scrubMessage(v)
  return maskText(v)
}

function redactValue(v: Json, path: string[], ctx: RedactCtx): Json {
  if (Array.isArray(v)) return path.at(-1) === 'headers' ? v.map((h) => redactHeader(h, ctx, path)) : v.map((e) => redactValue(e, path, ctx))
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, redactValue(val, [...path, k], ctx)]))
  if (typeof v === 'string') return redactString(path.at(-1) ?? '', path, v, ctx)
  return v
}

/** Redacts one parsed response body (D79). `path` starts empty: the root object's keys are depth 1. */
export function redactBody(body: unknown, pseudo: Pseudonyms): Json {
  return redactValue(body as Json, [], { pseudo })
}

function parseSentinel(v: string): Base64Summary {
  const [length, padding, ok, decoded] = v.slice(SENTINEL.length).split(',')
  return { length: Number(length), padding: Number(padding), alphabet_ok: ok === '1', decoded_bytes: Number(decoded) }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The streaming body scanner: reads a body chunk by chunk, keeps everything except the long `raw` / `data` base64url strings (which it summarises as
// it goes), so a large message never sits in memory. The kept text is Gmail's JSON skeleton; it is parsed and redacted at the end.

export class BodyScanner {
  private readonly decoder = new TextDecoder()
  private skeleton = ''
  private overflow = false
  private bytes = 0
  private inStr = false
  private esc = false
  private cur = ''
  private lastString = ''
  private prevSig = ''
  private big: { length: number; padding: number; ok: boolean; esc: boolean } | null = null

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength
    this.eat(this.decoder.decode(chunk, { stream: true }))
  }

  private emit(s: string): void {
    if (this.skeleton.length + s.length > SKELETON_LIMIT) this.overflow = true
    else this.skeleton += s
  }

  private eat(text: string): void {
    for (const ch of text) {
      const b = this.big
      if (b) {
        if (b.esc) {
          b.esc = false
          b.length++
        } else if (ch === '\\') {
          b.esc = true
          b.ok = false
          b.length++
        } else if (ch === '"') {
          const body = b.length - b.padding
          if (b.padding > 2 || body % 4 === 1) b.ok = false
          this.emit(`"${SENTINEL}${b.length},${b.padding},${b.ok ? 1 : 0},${decodedBytes(body)}"`)
          this.big = null
          this.prevSig = '"'
        } else {
          b.length++
          if (ch === '=') b.padding++
          else {
            if (b.padding > 0) b.ok = false
            b.padding = 0
            if (!/[A-Za-z0-9_-]/.test(ch)) b.ok = false
          }
        }
        continue
      }
      if (this.inStr) {
        this.emit(ch)
        if (this.esc) {
          this.esc = false
          this.cur += ch
        } else if (ch === '\\') {
          this.esc = true
          this.cur += ch
        } else if (ch === '"') {
          this.inStr = false
          this.lastString = this.cur
          this.prevSig = '"'
        } else this.cur += ch
        continue
      }
      if (ch === '"') {
        if (this.prevSig === ':' && (this.lastString === 'raw' || this.lastString === 'data')) {
          this.big = { length: 0, padding: 0, ok: true, esc: false }
          continue
        }
        this.inStr = true
        this.cur = ''
        this.emit(ch)
        continue
      }
      this.emit(ch)
      if (!/\s/.test(ch)) this.prevSig = ch
    }
  }

  /** The parsed skeleton (big members summarised), or null for a body that is not JSON or is too large to keep. */
  finish(): { json: unknown; bytes?: undefined } | { json?: undefined; bytes: number } {
    this.eat(this.decoder.decode())
    if (this.overflow) return { bytes: this.bytes }
    try {
      return { json: JSON.parse(this.skeleton) as unknown }
    } catch {
      return { bytes: this.bytes }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// One exchange

export type CallKind = 'token_refresh' | 'token_exchange' | 'token_other' | 'profile' | 'send_as' | 'history_list' | 'messages_list' | 'message_full' | 'message_raw' | 'attachment_get' | 'other'

/** What a recording file holds: the request's shape and the response's, redacted. `source` marks it for the replay (D80). */
export interface RecordedExchange {
  source: 'recorded' | 'synthetic'
  kind: CallKind
  request: { method: string; host: string; path: string; query: Array<[string, string]>; form: Record<string, string> | null }
  response: { status: number; headers: Record<string, string>; body: Json | { non_json: true; bytes: number } | null }
}

const PATH_WORDS = new Set(['gmail', 'v1', 'users', 'me', 'profile', 'settings', 'sendAs', 'history', 'messages', 'attachments', 'token'])
const KEEP_QUERY_VALUE = new Set(['format', 'maxResults', 'historyTypes', 'q'])
const ID_QUERY = new Set(['startHistoryId', 'pageToken'])

function kindOf(host: string, path: string, query: URLSearchParams, form: URLSearchParams | null): CallKind | null {
  if (host === 'oauth2.googleapis.com' && path === '/token') {
    const g = form?.get('grant_type')
    return g === 'refresh_token' ? 'token_refresh' : g === 'authorization_code' ? 'token_exchange' : 'token_other'
  }
  if (host !== 'gmail.googleapis.com') return null
  const rest = path.replace(/^\/gmail\/v1\/users\/me/, '')
  if (rest === '/profile') return 'profile'
  if (rest === '/settings/sendAs') return 'send_as'
  if (rest === '/history') return 'history_list'
  if (rest === '/messages') return 'messages_list'
  if (/^\/messages\/[^/]+$/.test(rest)) return query.get('format') === 'raw' ? 'message_raw' : 'message_full'
  if (/^\/messages\/[^/]+\/attachments\/[^/]+$/.test(rest)) return 'attachment_get'
  return 'other'
}

function redactRequest(url: URL, method: string, form: URLSearchParams | null, pseudo: Pseudonyms): RecordedExchange['request'] {
  const path = url.pathname
    .split('/')
    .map((seg) => (seg === '' || PATH_WORDS.has(seg) ? seg : pseudo.of(decodeURIComponent(seg))))
    .join('/')
  const query: Array<[string, string]> = [...url.searchParams].map(([k, v]) => [
    /^[A-Za-z0-9_]{1,40}$/.test(k) ? k : maskText(k),
    KEEP_QUERY_VALUE.has(k) ? v : ID_QUERY.has(k) ? pseudo.of(v) : maskText(v),
  ])
  // D79 rule 3: the token POST keeps its form keys and only `grant_type`'s value.
  const formOut = form === null ? null : Object.fromEntries([...form.keys()].map((k) => [/^[A-Za-z0-9_]{1,40}$/.test(k) ? k : maskText(k), k === 'grant_type' ? maskGrant(form.get(k)!) : '<redacted>']))
  return { method, host: url.host, path, query, form: formOut }
}
const maskGrant = (g: string): string => (g === 'refresh_token' || g === 'authorization_code' ? g : maskText(g))

function redactHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  const ct = h.get('content-type')
  if (ct !== null) out['content-type'] = ct.length <= 100 ? ct : maskText(ct)
  const ra = h.get('retry-after')
  if (ra !== null) out['retry-after'] = /^[\w ,:-]{1,40}$/.test(ra) ? ra : maskText(ra)
  return out
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The recorder

export interface RecordingRun {
  /** The Workflow instance id, or a request id for the connect callback. */
  id: string
  start: Date
}
export interface RecordingFetchDeps {
  plain: typeof fetch
  bucket: R2BucketLike
  run: RecordingRun
  clock: () => Date
  /** Recording stops at this instant. */
  until: Date
  random: (n: number) => Uint8Array
  log: (line: string) => void
}

interface IndexEntry {
  key: string
  kind: CallKind
  status: number
}

const compact = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The wrapped `fetch` of one run (a Workflow instance, or one callback request). Records per D78; changes nothing about the call. */
export function createRecordingFetch(d: RecordingFetchDeps): typeof fetch {
  const pseudo = new Pseudonyms(d.random)
  const prefix = `${RECORDINGS_PREFIX}${compact(d.run.start)}-${d.run.id.replace(/[^A-Za-z0-9._-]/g, '_')}/`
  const counts = new Map<string, number>()
  let seq = 0
  let loaded: Promise<void> | null = null
  let chain: Promise<void> = Promise.resolve()

  const readIndex = async (): Promise<IndexEntry[]> => {
    const obj = await d.bucket.get(RECORDINGS_INDEX_KEY)
    if (!obj?.body) return []
    const parsed = JSON.parse(await new Response(obj.body).text()) as { objects?: IndexEntry[] }
    return Array.isArray(parsed.objects) ? parsed.objects : []
  }
  // The caps hold across isolates and replays: the counts are seeded from the index entries of this run's prefix.
  const load = (): Promise<void> =>
    (loaded ??= readIndex().then(
      (entries) => {
        for (const e of entries) {
          if (!e.key.startsWith(prefix)) continue
          bump(e.kind, e.status)
          seq++
        }
      },
      (err) => d.log(`[recording] could not read the index: ${err instanceof Error ? err.name : 'error'}`),
    ))
  const capKey = (kind: CallKind, status: number): string => (status >= 200 && status < 300 ? `ok:${kind}` : `${kind}:${status}`)
  const bump = (kind: CallKind, status: number): void => void counts.set(capKey(kind, status), (counts.get(capKey(kind, status)) ?? 0) + 1)

  const withTimeout = <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => void (timer = setTimeout(() => rej(new Error('timeout')), RECORDING_TIMEOUT_MS)))
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
  }

  const write = async (key: string, entry: IndexEntry, record: RecordedExchange): Promise<void> => {
    try {
      await withTimeout(d.bucket.put(key, JSON.stringify(record, null, 2), { httpMetadata: { contentType: 'application/json' } }))
      chain = chain.then(async () => {
        const entries = await readIndex().catch(() => [] as IndexEntry[])
        if (!entries.some((e) => e.key === key)) entries.push(entry)
        await d.bucket.put(RECORDINGS_INDEX_KEY, JSON.stringify({ version: 1, objects: entries }, null, 2), { httpMetadata: { contentType: 'application/json' } })
      })
      await withTimeout(chain)
    } catch (err) {
      // The name only: never a message that might carry a key or a body.
      d.log(`[recording] write failed: ${err instanceof Error ? err.name : 'error'}`)
      chain = Promise.resolve()
    }
  }

  const inspect = async (input: RequestInfo | URL, init: RequestInit | undefined, res: Response): Promise<Response> => {
    if (d.clock().getTime() >= d.until.getTime()) return res
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    const rawBody = init?.body
    const form = typeof rawBody === 'string' ? new URLSearchParams(rawBody) : rawBody instanceof URLSearchParams ? rawBody : null
    const kind = kindOf(url.hostname, url.pathname, url.searchParams, form)
    if (kind === null) return res
    await load()
    if ((counts.get(capKey(kind, res.status)) ?? 0) >= RECORDING_CAP) return res
    bump(kind, res.status)
    const request = redactRequest(url, method, form, pseudo)
    const headers = redactHeaders(res.headers)
    const status = res.status
    const key = `${prefix}${String(++seq).padStart(3, '0')}-${kind}-${status}-${hex(d.random(3))}.json`
    const finish = async (scan: ReturnType<BodyScanner['finish']> | null): Promise<void> => {
      let body: RecordedExchange['response']['body'] = null
      if (scan) body = scan.json !== undefined ? redactBody(scan.json, pseudo) : { non_json: true, bytes: scan.bytes ?? 0 }
      await write(key, { key, kind, status }, { source: 'recorded', kind, request, response: { status, headers, body } })
    }
    if (res.body === null) {
      await finish(null)
      return res
    }
    const scanner = new BodyScanner()
    let broken = false
    const through = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        try {
          if (!broken) scanner.push(chunk)
        } catch {
          broken = true
        }
      },
      async flush() {
        try {
          await finish(broken ? { bytes: 0 } : scanner.finish())
        } catch (err) {
          d.log(`[recording] redaction failed: ${err instanceof Error ? err.name : 'error'}`)
        }
      },
    })
    return new Response(res.body.pipeThrough(through), { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  return async (input, init) => {
    const res = await d.plain(input, init)
    try {
      return await inspect(input, init, res)
    } catch (err) {
      d.log(`[recording] skipped: ${err instanceof Error ? err.name : 'error'}`)
      return res
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The composition's view

export interface GoogleRecordingDeps {
  /** `env.GOOGLE_RECORDING_UNTIL`. */
  raw: string | undefined
  /** `env.BODIES`; absent: recording is off. */
  bucket: R2BucketLike | undefined
  clock: () => Date
  /** The `fetch` the Gmail code used before; undefined means the global one. */
  plain: typeof fetch | undefined
  random?: (n: number) => Uint8Array
  log?: (line: string) => void
}

/** Parsed once per isolate. `fetchFor` hands over `plain` itself (unwrapped) while recording is off. */
export function googleRecording(d: GoogleRecordingDeps): { on: boolean; problem: RecordingSwitch['problem']; fetchFor(run: RecordingRun): typeof fetch | undefined } {
  const sw = parseRecordingSwitch(d.raw, d.clock())
  const log = d.log ?? ((line: string) => console.log(line))
  if (sw.problem) log(recordingProblemNotice(sw.problem))
  const on = sw.until !== null && d.bucket !== undefined
  return {
    on,
    problem: sw.problem,
    fetchFor: (run) =>
      on
        ? createRecordingFetch({ plain: d.plain ?? ((i, n) => fetch(i, n)), bucket: d.bucket!, run, clock: d.clock, until: sw.until!, random: d.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))), log })
        : d.plain,
  }
}
