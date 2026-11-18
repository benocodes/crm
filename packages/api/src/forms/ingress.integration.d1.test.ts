import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7, type PreparedOperation } from '@vibase/storage'
import { memoryObjectStore } from '../objects/store.js'
import { openD1Engine, SEED_AT, type Engine } from '../test/engines.js'
import { recordingObjectStore, type RecordingStore } from '../test/objects.js'
import { nodeStreams } from '../test/streams.js'
import {
  formLimiterKey,
  handleFormIngress,
  ipLimiterKey,
  type FormIngressPorts,
  type RateLimiter,
  type TurnstileVerdict,
  type TurnstileVerifier,
} from './ingress.js'
import type { FormSubmissionContext } from './submission.js'

// [[CHN429]]: the form ingress handler ([[CHN421]] D2-D7) through the real D1 capture program (Miniflare), with fake Turnstile and limiter ports.
const NOW = '2026-11-18T09:00:00.000Z'
const ORIGIN = 'https://site.test'
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})

let objects: RecordingStore
let n = 0
let dbCalls = 0
beforeEach(async () => {
  await e.reset()
  objects = recordingObjectStore(memoryObjectStore())
  dbCalls = 0
  verifier = fakeVerifier()
  ipLimiter = fakeLimiter('ip')
  formLimiter = fakeLimiter('form')
  order = []
})

// ---- fakes -------------------------------------------------------------------------------------------------

let order: string[] = []
const fakeVerifier = (verdict: TurnstileVerdict | Error = { outcome: 'passed', hostname: 'site.test' }) => {
  const calls: Array<{ token: string; ip?: string }> = []
  const port: TurnstileVerifier & { calls: typeof calls; verdict: TurnstileVerdict | Error } = {
    calls,
    verdict,
    async verify(input) {
      calls.push(input)
      order.push('turnstile')
      if (port.verdict instanceof Error) throw port.verdict
      return port.verdict
    },
  }
  return port
}
const fakeLimiter = (name = 'limiter') => {
  const keys: string[] = []
  const port: RateLimiter & { keys: string[]; success: boolean; throws: boolean } = {
    keys,
    success: true,
    throws: false,
    async limit({ key }) {
      keys.push(key)
      order.push(name)
      if (port.throws) throw new Error('limiter down')
      return { success: port.success }
    },
  }
  return port
}
let verifier = fakeVerifier()
let ipLimiter = fakeLimiter('ip')
let formLimiter = fakeLimiter('form')

/** The engine's binding counting every execution: a rate-limited request must make none. */
const countingBinding = () => ({
  ...e.binding,
  runtime: {
    ...e.binding.runtime,
    execute: ((identity: any, op: PreparedOperation<unknown>) => {
      dbCalls++
      return e.binding.runtime.execute(identity, op)
    }) as typeof e.binding.runtime.execute,
  },
})

const ctxOf = (over: Partial<FormSubmissionContext> = {}): FormSubmissionContext => ({
  binding: countingBinding() as typeof e.binding,
  organizationId: e.organizationId,
  objects,
  streams: nodeStreams(),
  clock: () => new Date(NOW),
  newId: () => uuidv7(new Date(NOW)),
  randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
  ...over,
})
const portsOf = (over: Partial<FormIngressPorts> = {}): FormIngressPorts => ({
  ctx: ctxOf(),
  turnstile: verifier,
  ipLimiter,
  formLimiter,
  ...over,
})

interface Seeded {
  id: string
  publicId: string
}
async function seedForm(over: Record<string, unknown> = {}, origins: string[] = [ORIGIN]): Promise<Seeded> {
  n++
  const id = `0190b2c4-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`
  await e.insert('principals', { id, kind: 'agent', created_at: SEED_AT })
  await e.insert('agents', { id, name: `Form agent ${n}`, scopes: [] })
  const publicId = `frm_${String(n).padStart(26, 'a')}`
  await e.insert('forms', {
    id,
    name: `Website ${n}`,
    public_id: publicId,
    enabled: true,
    email_field: 'email',
    phone_field: 'phone',
    name_field: 'name',
    consent_text: null,
    ...over,
  })
  for (const origin of origins) await e.insert('form_allowed_origins', { form_id: id, origin })
  return { id, publicId }
}
const tag = async () => (await e.insert('tags', { name: `Tag ${++n}` })).id as string

const urlencoded = (fields: Record<string, string | string[]>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x)
  return p.toString()
}
const TOKEN = { 'cf-turnstile-response': 'tok' }
const good = { email: 'jane@acme.test', name: 'Jane Roe', ...TOKEN }

interface Opts {
  method?: string
  origin?: string | null
  headers?: Record<string, string>
  ip?: string | null
}
const post = (
  seeded: Seeded,
  body: BodyInit | null,
  contentType: string | null,
  o: Opts = {},
  ports: FormIngressPorts = portsOf(),
) => {
  const headers: Record<string, string> = { ...o.headers }
  if (contentType !== null) headers['content-type'] = contentType
  const origin = o.origin === undefined ? ORIGIN : o.origin
  if (origin !== null) headers.origin = origin
  const init: RequestInit & { duplex?: string } = { method: o.method ?? 'POST', headers }
  if (body !== null && (o.method ?? 'POST') !== 'OPTIONS') {
    init.body = body
    if (body instanceof ReadableStream) init.duplex = 'half'
  }
  return handleFormIngress(ports, new Request('https://api.test/f/' + seeded.publicId, init), {
    publicId: seeded.publicId,
    ip: o.ip === undefined ? '203.0.113.7' : o.ip,
  })
}
const form = (s: Seeded, fields: Record<string, string | string[]>, o: Opts = {}, ports?: FormIngressPorts) =>
  post(s, urlencoded(fields), 'application/x-www-form-urlencoded', o, ports)
const jsonPost = (s: Seeded, doc: unknown, o: Opts = {}, ports?: FormIngressPorts) =>
  post(s, typeof doc === 'string' ? doc : JSON.stringify(doc), 'application/json', o, ports)

const bodyOf = async (r: Response) => JSON.parse(await r.text())
const headerSet = (r: Response) => [...r.headers.entries()].sort(([a], [b]) => a.localeCompare(b))

const TABLES = [
  'contacts',
  'identities',
  'threads',
  'messages',
  'interactions',
  'interaction_participants',
  'message_sources',
  'thread_sources',
  'associations',
  'events',
] as const
async function counts() {
  const out: Record<string, number> = {}
  for (const t of TABLES) out[t] = (await e.rows(t)).length
  return { ...out, objects: objects.writes.length }
}
const EMPTY = Object.fromEntries([...TABLES.map((t) => [t, 0]), ['objects', 0]])
const expectNothingWritten = async () => expect(await counts()).toEqual(EMPTY)
const storedOriginal = async () => {
  const [message] = await e.rows('messages')
  const key = `${message!.content_key}/v1/original.json`
  const got = (await objects.get(key))!
  return JSON.parse(new TextDecoder().decode(new Uint8Array(await new Response(got.body).arrayBuffer())))
}
const storedBody = async () => {
  const [message] = await e.rows('messages')
  const got = (await objects.get(`${message!.content_key}/v1/body.md`))!
  return new TextDecoder().decode(new Uint8Array(await new Response(got.body).arrayBuffer()))
}

const RECEIVED = { status: 'received' }

// ---- D2: formats and caps ------------------------------------------------------------------------------------

describe('formats and caps (D2)', () => {
  it('accepts urlencoded, multipart and JSON, each writing one form interaction as the form principal', async () => {
    for (const make of [
      (s: Seeded) => form(s, good),
      (s: Seeded) => {
        const fd = new FormData()
        for (const [k, v] of Object.entries(good)) fd.append(k, v)
        // The Request builds the multipart boundary itself.
        return handleFormIngress(
          portsOf(),
          new Request('https://api.test/f/x', { method: 'POST', body: fd, headers: { origin: ORIGIN } }),
          {
            publicId: s.publicId,
            ip: '203.0.113.7',
          },
        )
      },
      (s: Seeded) => jsonPost(s, good),
    ]) {
      await e.reset()
      objects = recordingObjectStore(memoryObjectStore())
      const s = await seedForm()
      const res = await make(s)
      expect(res.status).toBe(202)
      expect(await bodyOf(res)).toEqual(RECEIVED)
      expect(await e.rows('interactions')).toEqual([
        expect.objectContaining({ channel: 'form', direction: 'inbound', created_by: s.id }),
      ])
    }
  })

  it('a repeated key becomes an ordered array; JSON numbers and booleans are kept as their text', async () => {
    const s = await seedForm()
    expect((await form(s, { ...good, topic: ['b', 'a', 'c'] })).status).toBe(202)
    expect((await storedOriginal()).fields).toEqual([
      { name: 'email', value: 'jane@acme.test' },
      { name: 'name', value: 'Jane Roe' },
      { name: 'topic', value: ['b', 'a', 'c'] },
    ])
    await e.reset()
    objects = recordingObjectStore(memoryObjectStore())
    const j = await seedForm()
    expect((await jsonPost(j, { ...good, qty: 3, price: 1.5, ok: true, no: false, tags: ['x', 'y'] })).status).toBe(202)
    expect((await storedOriginal()).fields).toEqual([
      { name: 'email', value: 'jane@acme.test' },
      { name: 'name', value: 'Jane Roe' },
      { name: 'qty', value: '3' },
      { name: 'price', value: '1.5' },
      { name: 'ok', value: 'true' },
      { name: 'no', value: 'false' },
      { name: 'tags', value: ['x', 'y'] },
    ])
  })

  const big = 'x'.repeat(40 * 1024)
  const cases: Array<[string, (s: Seeded) => Promise<Response>, number, string]> = [
    ['an unsupported content type', (s) => post(s, 'hi', 'text/plain'), 415, 'unsupported_media_type'],
    ['no content type', (s) => post(s, 'hi', null), 415, 'unsupported_media_type'],
    [
      'a declared length over the cap',
      (s) => post(s, 'a=b', 'application/x-www-form-urlencoded', { headers: { 'content-length': '40000' } }),
      413,
      'payload_too_large',
    ],
    [
      'a body over the cap with an absent length (a stream)',
      (s) =>
        post(
          s,
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('a=' + big))
              c.close()
            },
          }),
          'application/x-www-form-urlencoded',
        ),
      413,
      'payload_too_large',
    ],
    [
      'a body over the cap with an understated length',
      (s) => {
        const body = new TextEncoder().encode(JSON.stringify({ a: big }))
        const req = new Request('https://api.test/f/x', {
          method: 'POST',
          body,
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
        })
        // A header the runtime would not let a client lie about: the test sets it on the request seen by the handler.
        const lied = new Proxy(req, {
          get: (t, p) =>
            p === 'headers'
              ? new Headers([...req.headers.entries(), ['content-length', '100']])
              : (Reflect.get(t, p, t) as unknown),
        }) as Request
        return handleFormIngress(portsOf(), lied, { publicId: s.publicId, ip: '203.0.113.7' })
      },
      413,
      'payload_too_large',
    ],
    [
      'more than 50 fields',
      (s) => form(s, { ...good, ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, 'v'])) }),
      400,
      'validation_error',
    ],
    ['a name over 64 characters', (s) => form(s, { ...good, ['n'.repeat(65)]: 'v' }), 400, 'validation_error'],
    [
      'an empty name',
      (s) => post(s, '=v&email=jane%40acme.test', 'application/x-www-form-urlencoded'),
      400,
      'validation_error',
    ],
    ['a name with a control character', (s) => form(s, { ...good, 'a\u0001b': 'v' }), 400, 'validation_error'],
    ['a value over 5,000 characters', (s) => form(s, { ...good, note: 'v'.repeat(5001) }), 400, 'validation_error'],
    [
      'a file part',
      (s) => {
        const fd = new FormData()
        fd.append('email', 'jane@acme.test')
        fd.append('cv', new File(['hello'], 'cv.txt', { type: 'text/plain' }))
        return handleFormIngress(
          portsOf(),
          new Request('https://api.test/f/x', { method: 'POST', body: fd, headers: { origin: ORIGIN } }),
          { publicId: s.publicId },
        )
      },
      400,
      'validation_error',
    ],
    ['a JSON array body', (s) => jsonPost(s, [1]), 400, 'validation_error'],
    ['invalid JSON', (s) => jsonPost(s, '{not json'), 400, 'validation_error'],
    ['a nested JSON value', (s) => jsonPost(s, { ...good, nest: { a: 1 } }), 400, 'validation_error'],
    ['a JSON array of numbers', (s) => jsonPost(s, { ...good, nums: [1, 2] }), 400, 'validation_error'],
    [
      'a JSON array over 20 strings',
      (s) => jsonPost(s, { ...good, many: Array.from({ length: 21 }, () => 'v') }),
      400,
      'validation_error',
    ],
    ['a JSON null', (s) => jsonPost(s, { ...good, nothing: null }), 400, 'validation_error'],
  ]
  it.each(cases)('%s is refused with its code and writes nothing', async (_name, run, status, code) => {
    const s = await seedForm()
    const res = await run(s)
    expect(res.status).toBe(status)
    expect((await bodyOf(res)).error.code).toBe(code)
    await expectNothingWritten()
    expect(verifier.calls).toEqual([])
  })

  it('a cap breach names the field', async () => {
    const s = await seedForm()
    const res = await form(s, { ...good, note: 'v'.repeat(5001) })
    expect((await bodyOf(res)).error.message).toContain('note')
  })

  it('the field cap counts reserved fields too, and a value is judged after trimming', async () => {
    const s = await seedForm()
    const many = Object.fromEntries(Array.from({ length: 46 }, (_, i) => [`f${i}`, 'v']))
    // email, name, token (3) + 46 + 1 reserved = 50: accepted; one more reserved field is 51.
    expect((await form(s, { ...good, ...many, _vb_x: '1' })).status).toBe(202)
    expect((await form(s, { ...good, ...many, _vb_x: '1', _vb_y: '1' })).status).toBe(400)
    expect((await form(s, { ...good, note: ' '.repeat(3000) + 'v'.repeat(5000) + ' '.repeat(3000) })).status).toBe(202)
  })

  it('a method other than POST or OPTIONS is 405, with no database query', async () => {
    const s = await seedForm()
    const res = await post(s, null, null, { method: 'GET' })
    expect(res.status).toBe(405)
    expect(dbCalls).toBe(0)
  })
})

// ---- D3: reserved fields ---------------------------------------------------------------------------------------

describe('what reaches the capture (D3)', () => {
  it('reserved fields are in neither body.md nor original.json fields; the route public_id is', async () => {
    const s = await seedForm({ consent_text: 'We store it.' })
    const res = await form(s, {
      ...good,
      note: 'Hello',
      _vb_hp: '',
      _vb_consent: 'on',
      _vb_anonymous_id: 'anon-1',
      _vb_other: 'zzz',
    })
    expect(res.status).toBe(202)
    const body = await storedBody()
    for (const name of [
      'cf-turnstile-response',
      '_vb_hp',
      '_vb_consent',
      '_vb_anonymous_id',
      '_vb_other',
      'tok',
      'zzz',
    ])
      expect(body).not.toContain(name)
    const original = await storedOriginal()
    expect(original.fields.map((x: { name: string }) => x.name)).toEqual(['email', 'name', 'note'])
    expect(original).toMatchObject({
      public_id: s.publicId,
      form_id: s.id,
      origin: ORIGIN,
      content_type: 'application/x-www-form-urlencoded',
      anonymous_id: 'anon-1',
      consent: { given: true, text: 'We store it.' },
    })
    expect(JSON.stringify(original)).not.toContain('tok')
  })

  it.each([
    ['email_field', { email_field: '_vb_email', phone_field: null }, { _vb_email: 'jane@acme.test', ...TOKEN }],
    [
      'email_field',
      { email_field: 'cf-turnstile-response', phone_field: null },
      { 'cf-turnstile-response': 'jane@acme.test' },
    ],
  ])('a form whose %s names a reserved field is never satisfied: email or phone required', async (_n, over, fields) => {
    const s = await seedForm(over)
    const res = await form(s, fields)
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).error.message).toBe('email or phone required')
    await expectNothingWritten()
  })

  it.each([
    ['true', true],
    ['ON', true],
    ['Yes', true],
    ['1', true],
    ['no', false],
    ['false', false],
    ['', false],
    ['2', false],
  ])('consent %j is given: %s', async (value, given) => {
    const s = await seedForm({ consent_text: 'We store it.' })
    expect((await form(s, { ...good, _vb_consent: value })).status).toBe(202)
    expect((await storedOriginal()).consent.given).toBe(given)
  })

  it('consent absent is not given', async () => {
    const s = await seedForm({ consent_text: 'We store it.' })
    await form(s, good)
    expect((await storedOriginal()).consent.given).toBe(false)
  })

  it.each(['has space', 'x'.repeat(129), 'bad/slash', ''])(
    'an invalid anonymous_id %j is dropped and the submission accepted',
    async (id) => {
      const s = await seedForm()
      expect((await form(s, { ...good, _vb_anonymous_id: id })).status).toBe(202)
      expect((await storedOriginal()).anonymous_id).toBeNull()
    },
  )

  it('a valid anonymous_id is kept (1-128 of A-Za-z0-9_.:-)', async () => {
    const s = await seedForm()
    expect((await form(s, { ...good, _vb_anonymous_id: 'A_b.c:d-9' })).status).toBe(202)
    expect((await storedOriginal()).anonymous_id).toBe('A_b.c:d-9')
  })

  it('no non-test module calls the handler: a match on an import of it or a call of it, not a substring (428.20)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const importsIt = /from\s+['"][^'"]*\/ingress(\.js)?['"]/
    const callsIt = /\bhandleFormIngress\s*\(/
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !/\.test\.ts$|\.suite\.ts$/.test(p) && !p.endsWith(join('forms', 'ingress.ts'))) {
          const code = readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
          if (importsIt.test(code) || callsIt.test(code)) hits.push(p.slice(root.length))
        }
      }
    }
    walk(root)
    expect(hits).toEqual([])
    // the matcher itself matches what it must
    expect(importsIt.test("import { handleFormIngress } from './forms/ingress.js'")).toBe(true)
    expect(importsIt.test("export * from './ingress'")).toBe(true)
    expect(importsIt.test("import { x } from './ingress-read.js'")).toBe(false)
    expect(callsIt.test('await handleFormIngress (ports, req, x)')).toBe(true)
  })
})

// ---- D4: the order ---------------------------------------------------------------------------------------------

describe('the order (D4)', () => {
  const errorOf = async (r: Response) => ({
    status: r.status,
    code: r.status === 202 ? 'received' : (await bodyOf(r)).error?.code,
  })

  it('step 1 before 2: a bad method or type is refused before a limiter is called', async () => {
    const s = await seedForm()
    expect((await errorOf(await post(s, 'x', 'text/plain'))).status).toBe(415)
    expect((await errorOf(await post(s, null, null, { method: 'PUT' }))).status).toBe(405)
    expect(ipLimiter.keys).toEqual([])
  })

  it('step 2 before 3: a rate-limited request for an unknown form is 429, with no database query', async () => {
    const s = { id: 'none', publicId: 'frm_' + 'z'.repeat(26) }
    ipLimiter.success = false
    const res = await form(s, good)
    expect(res.status).toBe(429)
    expect(dbCalls).toBe(0)
    expect(formLimiter.keys).toEqual([])
    ipLimiter.success = true
    formLimiter.success = false
    expect((await form(s, good)).status).toBe(429)
    expect(dbCalls).toBe(0)
  })

  it('step 3 before 4: an unknown form with a foreign origin is 404; step 4 before 5: a foreign origin with an invalid body is 403', async () => {
    const s = await seedForm()
    const ghost = { id: 'none', publicId: 'frm_' + 'z'.repeat(26) }
    expect((await errorOf(await form(ghost, good, { origin: 'https://evil.test' }))).code).toBe('not_found')
    expect((await errorOf(await form(s, { nothing: 'x' }, { origin: 'https://evil.test' }))).code).toBe(
      'origin_not_allowed',
    )
  })

  it('step 5 before 6, 7 and 8: an invalid body with the honeypot set, a blocked address or a bad token is 400 and the verifier is not called', async () => {
    const s = await seedForm()
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test' })
    for (const fields of [
      { name: 'x', _vb_hp: 'bot', ...TOKEN },
      { email: 'not-an-email', _vb_hp: 'bot', ...TOKEN },
      { phone: '', name: 'x', ...TOKEN },
    ]) {
      const res = await form(s, fields)
      expect(res.status).toBe(400)
    }
    expect(verifier.calls).toEqual([])
    await expectNothingWritten()
  })

  it('step 6 and 7 before 8: honeypot and blocked answer 202 without calling the verifier, writing nothing', async () => {
    const s = await seedForm()
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test' })
    verifier.verdict = { outcome: 'rejected' }
    expect((await form(s, { ...good, _vb_hp: 'bot' })).status).toBe(202)
    expect((await form(s, { ...good, email: 'x@evil.test' })).status).toBe(202)
    expect((await form(s, { ...good, email: 'x@sub.evil.test', _vb_hp: '' })).status).toBe(202)
    expect(verifier.calls).toEqual([])
    await expectNothingWritten()
  })

  it('step 6 before 7: a honeypot with a blocked address makes no blocklist read beyond the form read', async () => {
    const s = await seedForm()
    await e.insert('blocked_senders', { kind: 'domain', value: 'evil.test' })
    dbCalls = 0
    await form(s, { ...good, email: 'x@evil.test', _vb_hp: 'bot' })
    expect(dbCalls).toBe(1)
  })

  it('step 8 before 9: a failing challenge writes nothing', async () => {
    const s = await seedForm()
    verifier.verdict = { outcome: 'rejected' }
    expect((await form(s, good)).status).toBe(403)
    await expectNothingWritten()
    expect(verifier.calls).toEqual([{ token: 'tok', ip: '203.0.113.7' }])
  })

  it('the checks run in order: per-IP limiter, per-form limiter, then Turnstile last', async () => {
    const s = await seedForm()
    await form(s, good)
    expect(order).toEqual(['ip', 'form', 'turnstile'])
  })

  it('unknown and disabled forms give byte-identical 404s (and a deleted one too)', async () => {
    const disabled = await seedForm({ enabled: false })
    const deleted = await seedForm({ deleted_at: SEED_AT })
    const unknown = { id: 'none', publicId: 'frm_' + 'z'.repeat(26) }
    const answers = await Promise.all([disabled, deleted, unknown].map((x) => form(x, good)))
    const texts = await Promise.all(answers.map((r) => r.text()))
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404])
    expect(new Set(texts).size).toBe(1)
    expect(new Set(answers.map((r) => JSON.stringify(headerSet(r)))).size).toBe(1)
    expect(headerSet(answers[0]!).map(([k]) => k)).not.toContain('access-control-allow-origin')
  })
})

// ---- uniform answers and writes ----------------------------------------------------------------------------------

describe('uniform answers and writes (D4, D18)', () => {
  it('new, known, own, honeypot and blocked submissions give the same status, body and headers', async () => {
    const s = await seedForm()
    await e.insert('identities', { kind: 'email', value: 'staff@acme.test', contact_id: null, own: true })
    await e.insert('blocked_senders', { kind: 'address', value: 'spam@bad.test' })
    const answers: Response[] = []
    for (const fields of [
      good, // new
      good, // known now
      { ...good, email: 'staff@acme.test' }, // own
      { ...good, _vb_hp: 'bot' }, // honeypot
      { ...good, email: 'spam@bad.test' }, // blocked
    ])
      answers.push(await form(s, fields))
    expect(answers.map((r) => r.status)).toEqual([202, 202, 202, 202, 202])
    expect(new Set(await Promise.all(answers.map((r) => r.text()))).size).toBe(1)
    expect(new Set(answers.map((r) => JSON.stringify(headerSet(r)))).size).toBe(1)
  })

  it('an accepted submission writes one form interaction as the form principal, with that principal on every event', async () => {
    const s = await seedForm()
    expect((await form(s, good)).status).toBe(202)
    expect(await e.rows('interactions')).toEqual([
      expect.objectContaining({ channel: 'form', kind: 'message', direction: 'inbound', created_by: s.id }),
    ])
    const events = await e.rows('events')
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((r) => r.actor_id === s.id)).toBe(true)
  })

  it('honeypot, blocked and every refusal write nothing: no rows, events or objects', async () => {
    const s = await seedForm()
    await e.insert('blocked_senders', { kind: 'address', value: 'spam@bad.test' })
    const before = await counts()
    await form(s, { ...good, _vb_hp: 'bot' })
    await form(s, { ...good, email: 'spam@bad.test' })
    await form(s, { nothing: 'x' })
    await form(s, good, { origin: 'https://evil.test' })
    await form(
      s,
      { ...TOKEN, email: 'jane@acme.test' },
      {},
      portsOf({ turnstile: fakeVerifier({ outcome: 'rejected' }) }),
    )
    await post(s, 'x', 'text/plain')
    expect(await counts()).toEqual(before)
  })

  it('a capture failure is 503 temporarily_unavailable, with CORS and the objects cleaned', async () => {
    const s = await seedForm()
    const tagId = await tag()
    await e.insert('form_tags', { form_id: s.id, tag_id: tagId })
    objects.failWrites(() => true)
    const res = await form(s, good)
    expect(res.status).toBe(503)
    expect((await bodyOf(res)).error.code).toBe('temporarily_unavailable')
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect((await e.rows('messages')).length).toBe(0)
  })

  it('no error message names a contact, an identity or a tag', async () => {
    const s = await seedForm()
    const t = await tag()
    await e.insert('form_tags', { form_id: s.id, tag_id: t })
    await form(s, good)
    const bad = [
      await form(s, { nothing: 'x' }),
      await form(s, { ...good, email: 'jane@acme.test' }, { origin: 'https://evil.test' }),
      await form(s, good, {}, portsOf({ turnstile: fakeVerifier({ outcome: 'rejected' }) })),
    ]
    for (const r of bad) {
      const text = await r.text()
      expect(text).not.toContain('jane@acme.test')
      expect(text).not.toContain(t)
    }
  })
})

// ---- D5: origin and CORS ---------------------------------------------------------------------------------------

describe('origin and CORS (D5, P4, P5)', () => {
  it.each([
    ['missing', null],
    ['null', 'null'],
    ['foreign', 'https://evil.test'],
    ['a prefix of an allowed origin', 'https://site.test.evil.test'],
    ['a different case', 'https://SITE.test'],
  ])('a %s origin is 403 origin_not_allowed with no CORS headers', async (_n, origin) => {
    const s = await seedForm()
    const res = await form(s, good, { origin })
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error.code).toBe('origin_not_allowed')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')).toBeNull()
    await expectNothingWritten()
  })

  it('an allowed origin gets ACAO and Vary: Origin on a 400, a 403 challenge_failed, a 503 and the 202, never Allow-Credentials', async () => {
    const s = await seedForm()
    const rejected = portsOf({ turnstile: fakeVerifier({ outcome: 'rejected' }) })
    const down = portsOf({ turnstile: fakeVerifier({ outcome: 'unavailable' }) })
    const answers = [
      await form(s, { nothing: 'x' }), // 400
      await form(s, good, {}, rejected), // 403
      await form(s, good, {}, down), // 503
      await form(s, good), // 202
    ]
    expect(answers.map((r) => r.status)).toEqual([400, 403, 503, 202])
    for (const r of answers) {
      expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN)
      expect(r.headers.get('vary')).toBe('Origin')
      expect(r.headers.get('access-control-allow-credentials')).toBeNull()
    }
  })

  it('answers of steps 1-3 carry no CORS headers: 405, 415, 413, 429, 404', async () => {
    const s = await seedForm()
    const ghost = { id: 'none', publicId: 'frm_' + 'z'.repeat(26) }
    const limited = fakeLimiter()
    limited.success = false
    const answers = [
      await post(s, null, null, { method: 'GET' }),
      await post(s, 'x', 'text/plain'),
      await post(s, 'a=b', 'application/x-www-form-urlencoded', { headers: { 'content-length': '99999' } }),
      await form(s, good, {}, portsOf({ ipLimiter: limited })),
      await form(ghost, good),
    ]
    expect(answers.map((r) => r.status)).toEqual([405, 415, 413, 429, 404])
    for (const r of answers) expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })

  it("the preflight's 204 carries exactly D5's headers and writes nothing", async () => {
    const s = await seedForm()
    const res = await post(s, null, null, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      'access-control-allow-origin': ORIGIN,
      vary: 'Origin',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    })
    await expectNothingWritten()
    expect(verifier.calls).toEqual([])
  })

  it('a preflight from a refused origin is 403 and from an unknown or disabled form the same 404 as the POST, none with CORS headers', async () => {
    const s = await seedForm()
    const disabled = await seedForm({ enabled: false })
    const ghost = { id: 'none', publicId: 'frm_' + 'z'.repeat(26) }
    const refused = await post(s, null, null, { method: 'OPTIONS', origin: 'https://evil.test' })
    expect(refused.status).toBe(403)
    const missing = await post(s, null, null, { method: 'OPTIONS', origin: null })
    expect(missing.status).toBe(403)
    const a = await post(ghost, null, null, { method: 'OPTIONS' })
    const b = await post(disabled, null, null, { method: 'OPTIONS' })
    const postAnswer = await form(ghost, good)
    expect([a.status, b.status]).toEqual([404, 404])
    const postText = await postAnswer.text()
    expect(await a.text()).toBe(postText)
    expect(await b.text()).toBe(postText)
    for (const r of [refused, missing, a, b]) expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('a preflight counts against both limiters', async () => {
    const s = await seedForm()
    await post(s, null, null, { method: 'OPTIONS' })
    expect(ipLimiter.keys).toHaveLength(1)
    expect(formLimiter.keys).toHaveLength(1)
  })
})

// ---- D6, D7: Turnstile and limiters ----------------------------------------------------------------------------

describe('Turnstile and limiter ports (D6, D7, P1-P3)', () => {
  it('a missing or empty token is 403 challenge_failed without calling the verifier', async () => {
    const s = await seedForm()
    for (const fields of [
      { email: 'jane@acme.test' } as Record<string, string>,
      { email: 'jane@acme.test', 'cf-turnstile-response': '' },
    ]) {
      const res = await form(s, fields)
      expect(res.status).toBe(403)
      expect((await bodyOf(res)).error.code).toBe('challenge_failed')
    }
    expect(verifier.calls).toEqual([])
    await expectNothingWritten()
  })

  it('rejected, and a hostname that is not the origin host, are 403 challenge_failed; nothing written', async () => {
    const s = await seedForm()
    for (const verdict of [
      { outcome: 'rejected' },
      { outcome: 'passed', hostname: 'other.test' },
      { outcome: 'passed', hostname: 'site.test.evil.test' },
      { outcome: 'passed', hostname: '' },
    ] as TurnstileVerdict[]) {
      verifier.verdict = verdict
      const res = await form(s, good)
      expect(res.status).toBe(403)
      expect((await bodyOf(res)).error.code).toBe('challenge_failed')
    }
    await expectNothingWritten()
  })

  it('passed with the origin host is accepted, whatever its case; a port in the origin does not enter the comparison', async () => {
    const s = await seedForm({}, ['https://Site.test:8443'.toLowerCase()])
    verifier.verdict = { outcome: 'passed', hostname: 'SITE.test' }
    expect((await form(s, good, { origin: 'https://site.test:8443' })).status).toBe(202)
  })

  it('unavailable, and a verifier that throws, are 503 challenge_unavailable; nothing written', async () => {
    const s = await seedForm()
    for (const v of [{ outcome: 'unavailable' } as TurnstileVerdict, new Error('boom')]) {
      verifier.verdict = v
      const res = await form(s, good)
      expect(res.status).toBe(503)
      expect((await bodyOf(res)).error.code).toBe('challenge_unavailable')
    }
    await expectNothingWritten()
  })

  it('the verifier gets the token and the IP; no IP is passed when it is absent', async () => {
    const s = await seedForm()
    await form(s, good)
    await form(s, good, { ip: null })
    expect(verifier.calls).toEqual([{ token: 'tok', ip: '203.0.113.7' }, { token: 'tok' }])
  })

  it('both keys are pinned exactly, the per-IP first', async () => {
    const s = await seedForm()
    await form(s, good, { ip: '198.51.100.9' })
    expect(ipLimiter.keys).toEqual([`198.51.100.9:${s.publicId}`])
    expect(formLimiter.keys).toEqual([s.publicId])
    expect(ipLimiterKey('198.51.100.9', s.publicId)).toBe(`198.51.100.9:${s.publicId}`)
    expect(formLimiterKey(s.publicId)).toBe(s.publicId)
    expect(order.slice(0, 2)).toEqual(['ip', 'form'])
  })

  it('429 rate_limited carries Retry-After: 60; the second limiter is not called when the first refuses', async () => {
    const s = await seedForm()
    ipLimiter.success = false
    const res = await form(s, good)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect((await bodyOf(res)).error.code).toBe('rate_limited')
    expect(formLimiter.keys).toEqual([])
    expect(verifier.calls).toEqual([])
    ipLimiter.success = true
    formLimiter.success = false
    const second = await form(s, good)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('60')
    await expectNothingWritten()
  })

  it('absent limiters are skipped; a throwing limiter counts as no limiter and is logged', async () => {
    const s = await seedForm()
    expect((await form(s, good, {}, portsOf({ ipLimiter: undefined, formLimiter: undefined }))).status).toBe(202)
    ipLimiter.throws = true
    formLimiter.throws = true
    const logged: string[] = []
    expect((await form(s, { ...good, email: 'b@acme.test' }, {}, portsOf({ log: (m) => logged.push(m) }))).status).toBe(
      202,
    )
    expect(logged).toHaveLength(2)
    expect(ipLimiter.keys).toHaveLength(1)
    expect(formLimiter.keys).toHaveLength(1)
  })

  it("an absent IP uses the literal 'unknown' in the per-IP key (one shared bucket)", async () => {
    const s = await seedForm()
    await form(s, good, { ip: null })
    expect(ipLimiter.keys).toEqual([`unknown:${s.publicId}`])
  })
})
