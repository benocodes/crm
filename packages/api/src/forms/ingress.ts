import { defineOperation, execute, unit } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { formIngressRead, type FormIngress } from './ingress-read.js'
import { formSubmitter, type FormAnswer } from './map-submission.js'
import { captureFormSubmission, formSubmitterBlocked, type FormSubmissionContext } from './submission.js'

// [[CHN429]]: the public form ingress ([[CHN421]] D2-D7) as a function of a Request and injected ports. The D1 Worker routes `/f/*` to it ([[CHN432]]). D1 only, like the ingress read it uses.

/** D6, P1 (429.2): the verifier's answer. `hostname` is what siteverify returned; the handler compares it with the origin's host. */
export type TurnstileVerdict =
  | { outcome: 'passed'; hostname: string }
  | { outcome: 'rejected' }
  | { outcome: 'unavailable' }

/** The port the Worker implements with `fetch` against siteverify ([[CHN432]]); a fake in tests. `ip` is absent when the connecting IP is unknown (P3). */
export interface TurnstileVerifier {
  verify(input: { token: string; ip?: string }): Promise<TurnstileVerdict>
}

/** The shape of a Workers rate-limit binding (D7). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface FormIngressPorts {
  ctx: FormSubmissionContext
  turnstile: TurnstileVerifier
  /** `FORM_IP_LIMITER`: absent means skipped (D7). */
  ipLimiter?: RateLimiter | undefined
  /** `FORM_LIMITER`: absent means skipped (D7). */
  formLimiter?: RateLimiter | undefined
  /** A limiter that throws is logged here and counts as no limiter (P2, 429.3). */
  log?: (message: string, err: unknown) => void
}

export interface FormIngressRequest {
  /** The route's `public_id`. */
  publicId: string
  /** The connecting IP; absent when unknown (P3, 429.4). */
  ip?: string | null | undefined
}

export const MAX_BODY_BYTES = 32 * 1024
export const MAX_FIELDS = 50
export const MAX_NAME_LENGTH = 64
export const MAX_VALUE_LENGTH = 5000
export const MAX_ARRAY_ITEMS = 20
export const UNKNOWN_IP = 'unknown'

/** The limiter keys (429.10): the pair of limits D7 names, the IP one first. */
export const ipLimiterKey = (ip: string | null | undefined, publicId: string): string =>
  `${ip ? ip : UNKNOWN_IP}:${publicId}`
export const formLimiterKey = (publicId: string): string => publicId

const TOKEN_FIELD = 'cf-turnstile-response'
const HONEYPOT_FIELD = '_vb_hp'
const CONSENT_FIELD = '_vb_consent'
const ANONYMOUS_FIELD = '_vb_anonymous_id'
/** The reserved prefix: any `_vb_` name is consumed by the ingress (D3). */
export const RESERVED_PREFIX = '_vb_'
/** D3: the reserved field names the ingress reads; the docs page ([[CHN432]] D20) is checked against this list. */
export const RESERVED_FIELDS: readonly string[] = [TOKEN_FIELD, HONEYPOT_FIELD, CONSENT_FIELD, ANONYMOUS_FIELD]
/** The answers of the route (the spec's "The route" block): `status` and error `code` (`received` for the 202 body); the docs page is checked against this list and the handler's `ApiError`s against both. */
export const INGRESS_ANSWERS: ReadonlyArray<{ status: number; code: string }> = [
  { status: 202, code: 'received' },
  { status: 400, code: 'validation_error' },
  { status: 403, code: 'origin_not_allowed' },
  { status: 403, code: 'challenge_failed' },
  { status: 404, code: 'not_found' },
  { status: 405, code: 'method_not_allowed' },
  { status: 413, code: 'payload_too_large' },
  { status: 415, code: 'unsupported_media_type' },
  { status: 429, code: 'rate_limited' },
  { status: 503, code: 'challenge_unavailable' },
  { status: 503, code: 'temporarily_unavailable' },
]
const isReserved = (name: string): boolean => name === TOKEN_FIELD || name.startsWith(RESERVED_PREFIX)

type Raw = string | string[]

// ---- answers ---------------------------------------------------------------------------------------------------

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const refusal = (err: ApiError, headers: Record<string, string> = {}): Response =>
  json(err.status, err.toBody(), headers)

/** D5: non-credentialed CORS for an allowed origin; P4 (429.5) says where it applies. */
const corsOf = (origin: string): Record<string, string> => ({
  'access-control-allow-origin': origin,
  vary: 'Origin',
})

// ---- D2: the body ----------------------------------------------------------------------------------------------

const invalid = (message: string) => new ApiError(400, 'validation_error', message)
const tooLarge = () => new ApiError(413, 'payload_too_large', `the body is at most ${MAX_BODY_BYTES} bytes`)

/** Reads at most MAX_BODY_BYTES and stops reading at the first byte over it (the header can lie both ways, D2). */
async function readCapped(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const hasControl = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s)

/** One value, trimmed, within the cap; `name` is what the error names. */
function cleanValue(name: string, v: string): string {
  const t = v.trim()
  if (t.length > MAX_VALUE_LENGTH) throw invalid(`${name}: at most ${MAX_VALUE_LENGTH} characters`)
  return t
}

function checkName(name: string): void {
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || hasControl(name))
    throw invalid(`a field name is 1-${MAX_NAME_LENGTH} characters with no control characters`)
}

async function parseForm(bytes: Uint8Array, contentType: string): Promise<Map<string, Raw>> {
  let form: FormData
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw invalid('the body could not be parsed')
  }
  const out = new Map<string, Raw>()
  for (const [name, value] of form.entries()) {
    checkName(name)
    if (typeof value !== 'string') throw invalid(`${name}: a file part is not accepted`)
    const text = cleanValue(name, value)
    const prior = out.get(name)
    if (prior === undefined) out.set(name, text)
    else {
      const list = Array.isArray(prior) ? prior : [prior]
      if (list.length >= MAX_ARRAY_ITEMS) throw invalid(`${name}: at most ${MAX_ARRAY_ITEMS} values`)
      out.set(name, [...list, text])
    }
    if (out.size > MAX_FIELDS) throw invalid(`at most ${MAX_FIELDS} fields`)
  }
  return out
}

function parseJson(bytes: Uint8Array): Map<string, Raw> {
  let doc: unknown
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw invalid('the body is not valid JSON')
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw invalid('the body must be a JSON object')
  const out = new Map<string, Raw>()
  for (const [name, value] of Object.entries(doc as Record<string, unknown>)) {
    checkName(name)
    if (typeof value === 'string') out.set(name, cleanValue(name, value))
    else if (typeof value === 'number' && Number.isFinite(value)) out.set(name, cleanValue(name, JSON.stringify(value)))
    else if (typeof value === 'boolean') out.set(name, value ? 'true' : 'false')
    else if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) throw invalid(`${name}: at most ${MAX_ARRAY_ITEMS} values`)
      if (!value.every((v) => typeof v === 'string')) throw invalid(`${name}: an array holds strings only`)
      out.set(
        name,
        (value as string[]).map((v) => cleanValue(name, v)),
      )
    } else throw invalid(`${name}: a value is a string, number, boolean or array of strings`)
    if (out.size > MAX_FIELDS) throw invalid(`at most ${MAX_FIELDS} fields`)
  }
  return out
}

/** The media type of a Content-Type header, lowercase, or null. */
const mediaTypeOf = (header: string | null): string | null => header?.split(';')[0]?.trim().toLowerCase() || null
const ACCEPTED = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'application/json'])

// ---- D3: reserved fields ---------------------------------------------------------------------------------------

const asString = (v: Raw | undefined): string | undefined => (typeof v === 'string' ? v : undefined)
const CONSENT_TRUE = new Set(['true', 'on', 'yes', '1'])
const ANONYMOUS_ID = /^[A-Za-z0-9_.:-]{1,128}$/

interface Extracted {
  fields: FormAnswer[]
  token: string
  honeypot: boolean
  consent: boolean
  anonymousId: string | null
}

/** D3: reserved names are taken out before the submitter is chosen; only the rest are answers, in submission order. */
function extract(parsed: Map<string, Raw>): Extracted {
  const fields: FormAnswer[] = []
  for (const [name, value] of parsed) if (!isReserved(name)) fields.push({ name, value })
  const hp = parsed.get(HONEYPOT_FIELD)
  // 429.12: a value is trimmed when parsed, so whitespace alone is empty and does not trip the honeypot.
  const honeypot = (Array.isArray(hp) ? hp : hp === undefined ? [] : [hp]).some((v) => v !== '')
  const consent = asString(parsed.get(CONSENT_FIELD))
  const anonymous = asString(parsed.get(ANONYMOUS_FIELD))
  return {
    fields,
    token: asString(parsed.get(TOKEN_FIELD)) ?? '',
    honeypot,
    consent: consent !== undefined && CONSENT_TRUE.has(consent.toLowerCase()),
    anonymousId: anonymous !== undefined && ANONYMOUS_ID.test(anonymous) ? anonymous : null,
  }
}

// ---- the handler -----------------------------------------------------------------------------------------------

/**
 * Answers `POST /f/{public_id}` and its preflight in D4's order ([[CHN421]]): (1) method, content type, declared size; (2) the per-IP then the per-form limit;
 * (3) the form; (4) the origin; (5) parse and validate; (6) honeypot and (7) blocklist, both the uniform `202`; (8) Turnstile; (9) the capture.
 * Never throws: every failure is an answer.
 */
export async function handleFormIngress(
  ports: FormIngressPorts,
  request: Request,
  { publicId, ip }: FormIngressRequest,
): Promise<Response> {
  const preflight = request.method === 'OPTIONS'
  // 1. Method, content type, declared size. No CORS headers: the origin is not judged yet (P4).
  if (!preflight) {
    if (request.method !== 'POST')
      return refusal(new ApiError(405, 'method_not_allowed', 'POST is the only method'), {
        allow: 'POST, OPTIONS',
      })
    const type = mediaTypeOf(request.headers.get('content-type'))
    if (type === null || !ACCEPTED.has(type))
      return refusal(new ApiError(415, 'unsupported_media_type', 'send urlencoded, multipart or JSON'))
    const declared = Number(request.headers.get('content-length'))
    if (request.headers.has('content-length') && Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      return refusal(tooLarge())
  }

  // 2. Rate limits: before any database read. Both count preflights.
  const limited = await rateLimited(ports, publicId, ip)
  if (limited) return limited

  // 3. The form: unknown, deleted and disabled are one answer.
  let form: FormIngress | null
  try {
    form = await readForm(ports.ctx, publicId)
  } catch (err) {
    // 429.14: the origin is not judged yet, so no CORS headers (P4).
    ports.log?.('form ingress read failed', err)
    return refusal(new ApiError(503, 'temporarily_unavailable', 'the submission could not be recorded; try again'))
  }
  if (form === null || !form.enabled) return refusal(new ApiError(404, 'not_found', 'not found'))

  // 4. The origin: exact equality with a stored value (D5).
  const origin = request.headers.get('origin')
  if (origin === null || !form.allowed_origins.includes(origin))
    return refusal(new ApiError(403, 'origin_not_allowed', 'this origin may not submit to this form'))
  const cors = corsOf(origin)
  if (preflight)
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    })

  try {
    // 5. Parse and validate.
    const contentType = request.headers.get('content-type') ?? ''
    const bytes = await readCapped(request)
    const media = mediaTypeOf(contentType)
    const parsed = media === 'application/json' ? parseJson(bytes) : await parseForm(bytes, contentType)
    const { fields, token, honeypot, consent, anonymousId } = extract(parsed)
    const submitter = formSubmitter(form, fields)

    // 6, 7. Nothing written, the same answer as an accepted one.
    if (honeypot) return received(cors)
    if (await formSubmitterBlocked(ports.ctx, form, submitter)) return received(cors)

    // 8. Turnstile, closed on every doubt.
    const refused = await challenge(ports.turnstile, token, ip, origin)
    if (refused) return refusal(refused, cors)

    // 9. Store and capture.
    await captureFormSubmission(ports.ctx, {
      form,
      public_id: publicId,
      fields,
      consent_given: consent,
      anonymous_id: anonymousId,
      origin,
      content_type: media ?? contentType,
      received_at: ports.ctx.clock().toISOString(),
      submission_id: ports.ctx.newId(),
    })
    return received(cors)
  } catch (err) {
    if (err instanceof ApiError) return refusal(err, cors)
    ports.log?.('form ingress failed', err)
    return refusal(
      new ApiError(503, 'temporarily_unavailable', 'the submission could not be recorded; try again'),
      cors,
    )
  }
}

/** The uniform answer: accepted, honeypot and blocked are indistinguishable (D4). */
const received = (cors: Record<string, string>): Response => json(202, { status: 'received' }, cors)

async function rateLimited(ports: FormIngressPorts, publicId: string, ip: string | null | undefined) {
  const attempts: Array<[RateLimiter | undefined, string]> = [
    [ports.ipLimiter, ipLimiterKey(ip, publicId)],
    [ports.formLimiter, formLimiterKey(publicId)],
  ]
  for (const [limiter, key] of attempts) {
    if (!limiter) continue
    let ok = true
    try {
      ok = (await limiter.limit({ key })).success
    } catch (err) {
      // P2: a limiter outage is not a reason to refuse; Turnstile stays the gate.
      ports.log?.('form rate limiter failed', err)
    }
    if (!ok)
      return refusal(new ApiError(429, 'rate_limited', 'too many requests; try again shortly'), {
        'retry-after': '60',
      })
  }
  return null
}

async function readForm(ctx: FormSubmissionContext, publicId: string): Promise<FormIngress | null> {
  const out = await execute(
    ctx.binding,
    { kind: 'internal', organizationId: ctx.organizationId },
    defineOperation<FormIngress | null>({
      name: 'forms.ingress_read',
      mutates: false,
      reads: (qc) => ({ form: formIngressRead(qc, publicId).read }),
      build: (found, qc) =>
        unit({ steps: [], events: [], decode: () => formIngressRead(qc, publicId).decode(found.maybe('form')) }),
    }),
  )
  return out.value
}

/** D6, P1: the error to answer, or null when the challenge passed. */
async function challenge(
  verifier: TurnstileVerifier,
  token: string,
  ip: string | null | undefined,
  origin: string,
): Promise<ApiError | null> {
  const failed = new ApiError(403, 'challenge_failed', 'the challenge was not passed')
  if (token === '') return failed
  let verdict: TurnstileVerdict
  try {
    verdict = await verifier.verify(ip ? { token, ip } : { token })
  } catch {
    verdict = { outcome: 'unavailable' }
  }
  if (verdict.outcome === 'unavailable')
    return new ApiError(503, 'challenge_unavailable', 'the challenge could not be checked; try again')
  if (verdict.outcome === 'rejected') return failed
  return verdict.hostname.toLowerCase() === new URL(origin).hostname ? null : failed
}
