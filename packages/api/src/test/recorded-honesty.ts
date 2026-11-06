// Test-only ([[CHN5]] D86, [[CHN153b]]). The fixed-point check over a RECORDED file: every string in it must be allow-listed, or in the recorder's mask,
// pseudonym or `<redacted>` form. A hand edit that adds a word (a name, a sentence, an address) fails it, whatever the edit's intent.
// The rules are written here, apart from the recorder's own, so a recorder bug cannot excuse itself.
import { maskText } from '../channels/gmail/recorder.js'
import type { RecordedExchange } from '../channels/gmail/recorder.js'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

const isMask = (s: string): boolean => maskText(s) === s
const PSEUDONYM = /^[A-Za-z0-9_-]+$/
const ID_KEYS = new Set(['id', 'threadId', 'historyId', 'nextPageToken', 'attachmentId'])
const PATH_WORDS = new Set(['gmail', 'v1', 'users', 'me', 'profile', 'settings', 'sendAs', 'history', 'messages', 'attachments', 'token'])
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/
const SCOPE = /^(openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]{1,60})$/
const QUOTA_MESSAGE = /^Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail\.googleapis\.com' for consumer '[xX0_:]+'\.$/

/** Strings of the response body that may be in the clear, by key path (array indexes omitted). Returns whether `s` is acceptable at `path`. */
function bodyStringOk(path: string[], s: string): boolean {
  const key = path.at(-1) ?? ''
  const full = path.join('.')
  if (s === '<redacted>') return true
  if (isMask(s)) return true
  if (ID_KEYS.has(key)) return PSEUDONYM.test(s)
  if (key === 'labelIds') return /^[A-Z_]{2,40}$|^Label_\d{1,6}$/.test(s)
  if (key === 'mimeType') return MEDIA_TYPE.test(s)
  if (key === 'partId') return /^[0-9.]{0,20}$/.test(s)
  if (full === 'scope') return s.split(' ').every((x) => SCOPE.test(x))
  if (full === 'token_type') return s === 'Bearer'
  if (full === 'error.status') return /^[A-Z_]{3,40}$/.test(s)
  if (/^error\.errors\.(reason|domain)$/.test(full)) return /^[A-Za-z]{3,40}$/.test(s)
  if (full === 'error.message') return QUOTA_MESSAGE.test(s)
  if (full === 'id_token.alg') return /^[A-Za-z0-9-]{1,20}$/.test(s)
  if (full === 'id_token.iss') return s === 'https://accounts.google.com'
  if (path[0] === 'id_token' && path[1] === 'claims') return /^(string|number|boolean|null|object|array)$/.test(s)
  return false
}

const KNOWN_PARAMS = /^(boundary|charset|name|filename|format|delsp|type|start|protocol|micalg|size|creation-date|modification-date|read-date)(\*\d*\*?)?$/i
const STRUCTURED = new Set(['content-type', 'content-disposition', 'content-transfer-encoding'])
/** The frame of an RFC 2047 word survives masking (`=?UTF-8?B?` and `?=`); what is inside it must still be in mask form. */
const unframe = (v: string): string => v.replace(/=\?[^?\s]{1,40}\?[BbQq]\?/g, '').replace(/\?=/g, '')
function splitQuoted(v: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!
    if (ch === '\\' && quoted && i + 1 < v.length) {
      cur += ch + v[++i]!
      continue
    }
    if (ch === '"') quoted = !quoted
    if (ch === ';' && !quoted) (out.push(cur), (cur = ''))
    else cur += ch
  }
  return [...out, cur]
}
function headerValueOk(name: string, value: string): boolean {
  if (!STRUCTURED.has(name.toLowerCase())) return isMask(unframe(value))
  const [head = '', ...params] = splitQuoted(value)
  const h = head.trim()
  const headOk = name.toLowerCase() === 'content-type' ? MEDIA_TYPE.test(h) || isMask(h) : /^[A-Za-z0-9-]{1,40}$/.test(h) || isMask(h)
  return headOk && params.every((p) => {
    const i = p.indexOf('=')
    if (i < 0) return isMask(p)
    const pn = p.slice(0, i).trim()
    return (KNOWN_PARAMS.test(pn) || isMask(pn)) && isMask(unframe(p.slice(i + 1)))
  })
}

function walk(v: Json, path: string[], bad: string[]): void {
  if (Array.isArray(v) && path.at(-1) === 'headers') {
    for (const h of v as Array<{ name?: unknown; value?: unknown }>) {
      const name = typeof h.name === 'string' ? h.name : ''
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) && !isMask(name)) bad.push(`${path.join('.')}.name = ${JSON.stringify(h.name)}`)
      if (typeof h.value !== 'string' || !headerValueOk(name, h.value)) bad.push(`${path.join('.')} ${name} = ${JSON.stringify(h.value)}`)
    }
    return
  }
  if (Array.isArray(v)) return v.forEach((e) => walk(e, path, bad))
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) walk(x, [...path, k], bad)
    return
  }
  if (typeof v === 'string' && !bodyStringOk(path, v)) bad.push(`${path.join('.')} = ${JSON.stringify(v)}`)
}

/** What a recorded exchange holds that is neither allow-listed nor in mask, pseudonym or `<redacted>` form. Empty means honest. */
export function dishonestStrings(rec: RecordedExchange): string[] {
  const bad: string[] = []
  const { request, response } = rec
  if (request.method !== 'GET' && request.method !== 'POST') bad.push(`request.method = ${request.method}`)
  if (!/^(gmail|oauth2)\.googleapis\.com$/.test(request.host)) bad.push(`request.host = ${request.host}`)
  for (const seg of request.path.split('/')) if (seg !== '' && !PATH_WORDS.has(seg) && !PSEUDONYM.test(seg)) bad.push(`request.path segment = ${seg}`)
  for (const [k, v] of request.query) {
    const ok =
      k === 'format' ? v === 'full' || v === 'raw' || v === 'metadata'
      : k === 'maxResults' ? /^\d{1,4}$/.test(v)
      : k === 'historyTypes' ? /^[A-Za-z]{3,30}$/.test(v)
      : k === 'q' ? /^after:\d{1,12} \{in:inbox in:sent\}$|^after:\d{4}\/\d\d\/\d\d$/.test(v)
      : k === 'startHistoryId' || k === 'pageToken' ? PSEUDONYM.test(v)
      : isMask(v)
    if (!ok) bad.push(`request.query ${k} = ${v}`)
  }
  if (request.form !== null) for (const [k, v] of Object.entries(request.form)) if (!(v === '<redacted>' || (k === 'grant_type' && /^(refresh_token|authorization_code)$/.test(v)) || isMask(v))) bad.push(`request.form ${k} = ${v}`)
  for (const [k, v] of Object.entries(response.headers)) {
    const ok = k === 'content-type' ? /^application\/json; charset=(UTF-8|utf-8)$/.test(v) : k === 'retry-after' ? /^\d{1,6}$/.test(v) : false
    if (!ok) bad.push(`response.headers ${k} = ${v}`)
  }
  if (response.body !== null) walk(response.body as Json, [], bad)
  return bad
}
